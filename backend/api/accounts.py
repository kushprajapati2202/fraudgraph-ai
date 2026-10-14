from fastapi import APIRouter, Query

from backend.db import connect, row_to_dict
from backend.errors import not_found
from backend.services import mitigation

router = APIRouter(tags=["accounts"])


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/accounts/{account_id}")
def get_account(account_id: str) -> dict:
    """Account profile: holder details, activity summary, top counterparties, linked cases, recent transfers."""
    with connect() as conn:
        account = row_to_dict(conn.execute("SELECT * FROM accounts WHERE account_id = ?", (account_id,)).fetchone())
        if account is None:
            raise not_found("Account", account_id[:40])
        account.pop("demo_label", None)
        out = conn.execute("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total, MIN(timestamp) AS first, "
                           "MAX(timestamp) AS last FROM transactions WHERE source_account = ?", (account_id,)).fetchone()
        inc = conn.execute("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total, MIN(timestamp) AS first, "
                           "MAX(timestamp) AS last FROM transactions WHERE destination_account = ?", (account_id,)).fetchone()
        max_score = conn.execute(
            "SELECT MAX(ra.score) FROM risk_assessments ra JOIN transactions t ON t.transaction_id = ra.transaction_id "
            "WHERE t.source_account = ? OR t.destination_account = ?", (account_id, account_id)).fetchone()[0]
        counterparties = [dict(r) for r in conn.execute(
            "SELECT other AS account_id, a.holder_name, COUNT(*) AS transfers, SUM(amount) AS total FROM ("
            " SELECT destination_account AS other, amount FROM transactions WHERE source_account = ?"
            " UNION ALL SELECT source_account AS other, amount FROM transactions WHERE destination_account = ?) x "
            "LEFT JOIN accounts a ON a.account_id = x.other GROUP BY other ORDER BY total DESC LIMIT 6",
            (account_id, account_id))]
        cases = [dict(r) for r in conn.execute(
            "SELECT case_id, title, status, risk_score, risk_band FROM cases WHERE active = 1 AND accounts_json LIKE ? "
            "ORDER BY risk_score DESC", (f'%"{account_id}"%',))]
        recent = [dict(r) for r in conn.execute(
            "SELECT t.transaction_id, t.source_account, t.destination_account, t.amount, t.currency, t.timestamp, "
            "t.channel, ra.score, ra.risk_band, tc.status AS control_status, sa.holder_name AS source_name, "
            "da.holder_name AS destination_name "
            "FROM transactions t LEFT JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id "
            "LEFT JOIN transfer_controls tc ON tc.transaction_id = t.transaction_id "
            "LEFT JOIN accounts sa ON sa.account_id = t.source_account "
            "LEFT JOIN accounts da ON da.account_id = t.destination_account "
            "WHERE t.source_account = ? OR t.destination_account = ? ORDER BY t.timestamp DESC LIMIT 10",
            (account_id, account_id))]
        devices = [r[0] for r in conn.execute(
            "SELECT DISTINCT device_id FROM transactions WHERE source_account = ? AND device_id IS NOT NULL LIMIT 5",
            (account_id,))]
        controls = [{k: c[k] for k in ("action_id", "action_code", "label", "case_id", "actor_label", "created_at",
                                       "expires_at")} for c in mitigation.active_controls(conn, [account_id])]
    stamps = [s for s in (out["first"], inc["first"]) if s]
    lasts = [s for s in (out["last"], inc["last"]) if s]
    return {
        "account": account,
        "summary": {
            "outgoing_count": out["n"], "outgoing_total": out["total"],
            "incoming_count": inc["n"], "incoming_total": inc["total"],
            "first_activity": min(stamps) if stamps else None,
            "last_activity": max(lasts) if lasts else None,
            "max_score": max_score,
            "devices": devices,
        },
        "counterparties": counterparties,
        "controls": controls,
        "cases": cases,
        "recent_transactions": recent,
    }


@router.get("/search")
def search(q: str = Query(min_length=2, max_length=64)) -> dict:
    """Global search across cases, accounts (ID, holder name, account number) and transactions (ID, reference)."""
    like = _like(q.strip())
    with connect() as conn:
        cases = [dict(r) for r in conn.execute(
            "SELECT case_id, title, status, risk_score, risk_band FROM cases WHERE active = 1 AND "
            "(case_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR accounts_json LIKE ? ESCAPE '\\') "
            "ORDER BY risk_score DESC LIMIT 5", (like, like, like))]
        accounts = [dict(r) for r in conn.execute(
            "SELECT account_id, holder_name, account_type, city, account_number FROM accounts WHERE "
            "account_id LIKE ? ESCAPE '\\' OR holder_name LIKE ? ESCAPE '\\' OR account_number LIKE ? ESCAPE '\\' "
            "ORDER BY account_id LIMIT 6", (like, like, like))]
        transactions = [dict(r) for r in conn.execute(
            "SELECT t.transaction_id, t.reference, t.amount, t.currency, t.timestamp, t.source_account, "
            "t.destination_account, ra.risk_band, ra.score FROM transactions t "
            "LEFT JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id "
            "WHERE t.transaction_id LIKE ? ESCAPE '\\' OR t.reference LIKE ? ESCAPE '\\' "
            "ORDER BY t.timestamp DESC LIMIT 6", (like, like))]
    return {"query": q, "cases": cases, "accounts": accounts, "transactions": transactions}
