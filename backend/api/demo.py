from datetime import timedelta

from fastapi import APIRouter, Depends

from backend.api.deps import require_demo_token
from backend.db import connect
from backend.services import dataset, synthetic_data
from backend.services.risk_engine import parse_ts

router = APIRouter(tags=["demo"])


@router.post("/demo/reset", dependencies=[Depends(require_demo_token)])
def reset_demo() -> dict:
    with connect() as conn:
        summary = dataset.reset(conn)
    return {**summary, "message": "Synthetic dataset restored to baseline. Run analysis to rebuild cases."}


@router.get("/demo/scenarios")
def scenarios() -> dict:
    """Labeled scenarios (ground truth for evaluation; never used by the risk engine) and a suggested what-if."""
    with connect() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT l.scenario_id, l.transaction_id, t.source_account, t.destination_account, t.amount, t.timestamp "
            "FROM labels l JOIN transactions t ON t.transaction_id = l.transaction_id "
            "WHERE l.scenario_id NOT IN ('background', 'what-if') ORDER BY t.timestamp")]
        cases = [dict(r) for r in conn.execute("SELECT case_id, transaction_ids_json FROM cases WHERE active = 1")]

    by_scenario: dict[str, list[dict]] = {}
    for r in rows:
        by_scenario.setdefault(r["scenario_id"], []).append(r)

    out = []
    for s in synthetic_data.SCENARIOS:
        txs = by_scenario.get(s["scenario_id"], [])
        tx_ids = {t["transaction_id"] for t in txs}
        case_ids = [c["case_id"] for c in cases if any(f'"{t}"' in c["transaction_ids_json"] for t in tx_ids)]
        out.append({**s, "transaction_ids": [t["transaction_id"] for t in txs], "case_ids": case_ids})

    suggested = None
    layered = by_scenario.get("layered-transfer-01", [])
    if layered:
        last = layered[-1]
        collector = last["destination_account"]
        inbound = sum(t["amount"] for t in layered if t["destination_account"] == collector)
        suggested = {
            "label": "Collector moves consolidated funds to a new synthetic account",
            "source_account": collector,
            "destination_account": "AC-901",
            "amount": round(inbound * 0.95, -3),
            "timestamp": (parse_ts(last["timestamp"]) + timedelta(minutes=12)).isoformat(),
            "channel": "IMPS",
            "description": "What-if: onward transfer (synthetic)",
        }
    return {"scenarios": out, "suggested_what_if": suggested}
