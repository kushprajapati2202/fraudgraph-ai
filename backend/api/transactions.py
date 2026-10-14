import json
import re
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query

from backend.api.deps import require_demo_token
from backend.db import connect, row_to_dict, utcnow
from backend.errors import AppError, not_found
from backend.models.schemas import DemoTransactionRequest
from backend.services import audit, mitigation
from backend.services.investigation import tx_evidence_id
from backend.services.risk_engine import parse_ts

router = APIRouter(tags=["transactions"])

DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$"
SORT_COLUMNS = {"timestamp": "t.timestamp", "amount": "t.amount", "score": "ra.score", "transaction_id": "t.transaction_id"}
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/transactions")
def list_transactions(
    account_id: str | None = Query(default=None, pattern=r"^AC-\d{3,4}$"),
    from_: str | None = Query(default=None, alias="from", pattern=DATE_PATTERN),
    to: str | None = Query(default=None, pattern=DATE_PATTERN),
    min_amount: float | None = Query(default=None, ge=0),
    max_amount: float | None = Query(default=None, ge=0),
    q: str | None = Query(default=None, max_length=64),
    channel: Literal["UPI", "IMPS", "NEFT", "CARD", "WALLET"] | None = None,
    risk_band: Literal["LOW", "MEDIUM", "HIGH"] | None = None,
    synthetic_only: bool = False,
    sort: Literal["timestamp", "amount", "score", "transaction_id"] = "timestamp",
    order: Literal["asc", "desc"] = "desc",
    page: int = Query(default=1, ge=1, le=10_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where, params = [], []
    if account_id:
        where.append("(t.source_account = ? OR t.destination_account = ?)")
        params += [account_id, account_id]
    if from_:
        where.append("t.timestamp >= ?")
        params.append(from_)
    if to:
        where.append("t.timestamp <= ?")
        params.append(to + "T23:59:59" if len(to) == 10 else to)
    if min_amount is not None:
        where.append("t.amount >= ?")
        params.append(min_amount)
    if max_amount is not None:
        where.append("t.amount <= ?")
        params.append(max_amount)
    if q:
        where.append("(t.transaction_id LIKE ? ESCAPE '\\' OR t.source_account LIKE ? ESCAPE '\\' OR "
                     "t.destination_account LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR "
                     "t.reference LIKE ? ESCAPE '\\' OR sa.holder_name LIKE ? ESCAPE '\\' OR "
                     "da.holder_name LIKE ? ESCAPE '\\')")
        params += [_like(q)] * 7
    if channel:
        where.append("t.channel = ?")
        params.append(channel)
    if risk_band:
        where.append("ra.risk_band = ?")
        params.append(risk_band)
    if synthetic_only:
        where.append("t.is_synthetic_added = 1")
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    base = (f"FROM transactions t LEFT JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id "
            f"LEFT JOIN transfer_controls tc ON tc.transaction_id = t.transaction_id "
            f"LEFT JOIN accounts sa ON sa.account_id = t.source_account "
            f"LEFT JOIN accounts da ON da.account_id = t.destination_account {clause}")
    direction = "ASC" if order == "asc" else "DESC"
    with connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) {base}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT t.*, ra.score, ra.risk_band, tc.status AS control_status, sa.holder_name AS source_name, "
            f"da.holder_name AS destination_name {base} ORDER BY {SORT_COLUMNS[sort]} {direction}, t.transaction_id "
            f"{direction} LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size],
        ).fetchall()
    return {"items": [dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


def _transaction_detail(conn, transaction_id: str) -> dict:
    tx = row_to_dict(conn.execute("SELECT * FROM transactions WHERE transaction_id = ?", (transaction_id,)).fetchone())
    if tx is None:
        raise not_found("Transaction", transaction_id)
    ra = conn.execute("SELECT * FROM risk_assessments WHERE transaction_id = ?", (transaction_id,)).fetchone()
    assessment = None
    if ra:
        extra = json.loads(ra["uncertainties_json"])
        assessment = {
            "score": ra["score"], "risk_band": ra["risk_band"], "signals": json.loads(ra["signals_json"]),
            "uncertainties": extra["uncertainties"], "baseline": extra["baseline"],
            "time_window_minutes": extra["time_window_minutes"], "rule_version": ra["rule_version"],
            "analysis_id": ra["analysis_id"],
        }
    cases = [dict(r) for r in conn.execute(
        "SELECT case_id, title, status, risk_score, risk_band FROM cases WHERE active = 1 AND transaction_ids_json LIKE ?",
        (f'%"{transaction_id}"%',))]
    label = row_to_dict(conn.execute("SELECT scenario_id, label FROM labels WHERE transaction_id = ?",
                                     (transaction_id,)).fetchone())
    accounts = {r["account_id"]: dict(r) for r in conn.execute(
        "SELECT * FROM accounts WHERE account_id IN (?, ?)", (tx["source_account"], tx["destination_account"]))}
    control = row_to_dict(conn.execute("SELECT * FROM transfer_controls WHERE transaction_id = ?",
                                       (transaction_id,)).fetchone())
    return {
        "transaction": tx,
        "accounts": accounts,
        "control": control,
        "assessment": assessment,
        "cases": cases,
        "evidence_id": tx_evidence_id(transaction_id),
        "ground_truth": label,
        "ground_truth_note": "Synthetic scenario label for evaluation only; not used by the risk engine.",
    }


@router.get("/transactions/{transaction_id}")
def get_transaction(transaction_id: str) -> dict:
    if not re.fullmatch(r"TX-[A-Z0-9]{1,12}", transaction_id):
        raise not_found("Transaction", transaction_id[:40])
    with connect() as conn:
        return _transaction_detail(conn, transaction_id)


@router.post("/transactions/demo", status_code=201, dependencies=[Depends(require_demo_token)])
def create_demo_transaction(body: DemoTransactionRequest) -> dict:
    if body.source_account == body.destination_account:
        raise AppError(422, "VALIDATION_ERROR", "Source and destination accounts must differ.",
                       [{"field": "destination_account"}])
    with connect() as conn:
        lo, hi = conn.execute("SELECT MIN(timestamp), MAX(timestamp) FROM transactions").fetchone()
        if lo is None:
            raise AppError(409, "DATASET_NOT_LOADED", "Reset the demo dataset before adding transactions.")
        if body.timestamp is None:
            ts = parse_ts(hi) + timedelta(minutes=5)
        else:
            ts = body.timestamp.replace(tzinfo=None, microsecond=0)
        start, end = parse_ts(lo).replace(hour=0, minute=0, second=0), parse_ts(hi) + timedelta(days=1)
        if not (start <= ts <= end):
            raise AppError(422, "VALIDATION_ERROR",
                           f"Timestamp must be between {start.isoformat()} and {end.isoformat()} (synthetic dataset window).",
                           [{"field": "timestamp"}])

        created_accounts = []
        for field in ("source_account", "destination_account"):
            acc = getattr(body, field)
            if conn.execute("SELECT 1 FROM accounts WHERE account_id = ?", (acc,)).fetchone():
                continue
            if not (900 <= int(acc.split("-")[1]) <= 999):
                raise AppError(422, "VALIDATION_ERROR",
                               f"Unknown account {acc}. New synthetic accounts must use AC-900 to AC-999.",
                               [{"field": field}])
            conn.execute(
                "INSERT INTO accounts(account_id, account_type, created_at, demo_label, holder_name, account_number, city, "
                "branch_code, kyc_tier) VALUES (?, 'PERSONAL', ?, 'WHAT_IF', ?, ?, 'Unknown', 'FGBK0SIM00', 'MIN_KYC')",
                (acc, ts.strftime("%Y-%m-%d"), f"New beneficiary {acc[3:]} (simulated)", f"5099{int(acc[3:]):08d}"))
            created_accounts.append(acc)

        if body.transaction_id:
            tx_id = body.transaction_id
            if conn.execute("SELECT 1 FROM transactions WHERE transaction_id = ?", (tx_id,)).fetchone():
                raise AppError(409, "DUPLICATE_TRANSACTION", f"Transaction {tx_id} already exists; IDs must be unique.")
        else:
            n = conn.execute("SELECT COUNT(*) FROM transactions WHERE transaction_id LIKE 'TX-D%'").fetchone()[0] + 1
            while conn.execute("SELECT 1 FROM transactions WHERE transaction_id = ?", (f"TX-D{n:03d}",)).fetchone():
                n += 1
            tx_id = f"TX-D{n:03d}"

        description = CONTROL_CHARS.sub(" ", body.description).strip() if body.description else None
        conn.execute(
            "INSERT INTO transactions(transaction_id, source_account, destination_account, amount, currency, timestamp, "
            "channel, device_id, description, reference, is_synthetic_added) VALUES (?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, 1)",
            (tx_id, body.source_account, body.destination_account, round(body.amount, 2),
             ts.strftime("%Y-%m-%dT%H:%M:%S"), body.channel, body.device_id, description,
             f"SIM{ts:%y%j}{tx_id[4:]:0>6}"),
        )
        conn.execute("INSERT INTO labels(transaction_id, scenario_id, label) VALUES (?, 'what-if', 'UNLABELED')", (tx_id,))
        audit.record(conn, "SYNTHETIC_TX_ADDED", audit.ACTOR_HUMAN,
                     {"transaction_id": tx_id, "created_accounts": created_accounts, "added_at": utcnow()})
        # Controls approved by an analyst are enforced here, before the transfer is treated as released.
        control = mitigation.apply_controls(conn, {
            "transaction_id": tx_id, "source_account": body.source_account,
            "destination_account": body.destination_account, "amount": round(body.amount, 2)})
        detail = _transaction_detail(conn, tx_id)
    if control and control["status"] == "HELD":
        message = f"Transfer held for review: {control['account_id']} is on hold under case {control['case_id']}."
    elif control:
        message = f"Transfer flagged: {control['account_id']} is under enhanced monitoring (case {control['case_id']})."
    else:
        message = "Synthetic transaction added (fictional). Run analysis to update findings."
    return {**detail, "created_accounts": created_accounts, "message": message}
