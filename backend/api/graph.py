import json
from datetime import timedelta

from fastapi import APIRouter, Query

from backend.db import connect
from backend.errors import not_found
from backend.services import graph_engine
from backend.services.risk_engine import CASE_MIN_SCORE, parse_ts

router = APIRouter(tags=["graph"])

MAX_CONTEXT_EDGES = 80
MAX_ACCOUNT_EDGES = 150
MAX_NETWORK_EDGES = 400


def _assessments(conn, tx_ids: list[str]) -> dict[str, dict]:
    if not tx_ids:
        return {}
    marks = ",".join("?" * len(tx_ids))
    return {r["transaction_id"]: {"score": r["score"], "risk_band": r["risk_band"]} for r in conn.execute(
        f"SELECT transaction_id, score, risk_band FROM risk_assessments WHERE transaction_id IN ({marks})", tx_ids)}


def _accounts(conn, rows: list[dict]) -> dict[str, dict]:
    ids = sorted({a for r in rows for a in (r["source_account"], r["destination_account"])})
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    return {r["account_id"]: dict(r) for r in conn.execute(f"SELECT * FROM accounts WHERE account_id IN ({marks})", ids)}


@router.get("/graph")
def get_graph(
    case_id: str | None = Query(default=None, max_length=32),
    account_id: str | None = Query(default=None, pattern=r"^AC-\d{3,4}$"),
    time_window_minutes: int = Query(default=60, ge=10, le=1440),
    include_context: bool = True,
) -> dict:
    with connect() as conn:
        focus: set[str] = set()
        paths: list[dict] = []
        if case_id:
            case = conn.execute("SELECT * FROM cases WHERE case_id = ?", (case_id,)).fetchone()
            if case is None:
                raise not_found("Case", case_id)
            focus = set(json.loads(case["transaction_ids_json"]))
            accounts = json.loads(case["accounts_json"])
            marks = ",".join("?" * len(focus))
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM transactions WHERE transaction_id IN ({marks})", list(focus))]
            if include_context and rows:
                lo = min(parse_ts(r["timestamp"]) for r in rows) - timedelta(minutes=time_window_minutes)
                hi = max(parse_ts(r["timestamp"]) for r in rows) + timedelta(minutes=time_window_minutes)
                acc_marks = ",".join("?" * len(accounts))
                context = conn.execute(
                    f"SELECT * FROM transactions WHERE (source_account IN ({acc_marks}) OR destination_account IN ({acc_marks})) "
                    f"AND timestamp BETWEEN ? AND ? ORDER BY timestamp LIMIT ?",
                    [*accounts, *accounts, lo.isoformat(), hi.isoformat(), MAX_CONTEXT_EDGES + len(rows)],
                ).fetchall()
                rows += [dict(r) for r in context if r["transaction_id"] not in focus][:MAX_CONTEXT_EDGES]
            for r in conn.execute("SELECT evidence_id, payload_json FROM case_evidence WHERE case_id = ? AND "
                                  "source_type = 'GRAPH_PATH' ORDER BY sort_order", (case_id,)):
                paths.append({"evidence_id": r["evidence_id"], **json.loads(r["payload_json"])})
            scope = {"type": "case", "case_id": case_id}
        elif account_id:
            rows = [dict(r) for r in conn.execute(
                "SELECT * FROM transactions WHERE source_account = ? OR destination_account = ? "
                "ORDER BY timestamp DESC LIMIT ?", (account_id, account_id, MAX_ACCOUNT_EDGES))]
            if not rows and not conn.execute("SELECT 1 FROM accounts WHERE account_id = ?", (account_id,)).fetchone():
                raise not_found("Account", account_id)
            scope = {"type": "account", "account_id": account_id}
        else:
            rows = [dict(r) for r in conn.execute(
                "SELECT t.* FROM transactions t JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id "
                "WHERE ra.score >= ? ORDER BY ra.score DESC, t.timestamp LIMIT ?", (CASE_MIN_SCORE, MAX_NETWORK_EDGES))]
            focus = {r["transaction_id"] for r in rows}
            scope = {"type": "flagged_network", "min_score": CASE_MIN_SCORE}

        payload = graph_engine.to_payload(rows, _assessments(conn, [r["transaction_id"] for r in rows]),
                                          _accounts(conn, rows), focus, paths)
    return {"scope": scope, "time_window_minutes": time_window_minutes, **payload}
