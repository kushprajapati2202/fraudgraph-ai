import json

from fastapi import APIRouter

from backend.db import connect, get_meta, row_to_dict
from backend.services import mitigation
from backend.services.risk_engine import CASE_MIN_SCORE, LABELS

router = APIRouter(tags=["dashboard"])

BANDS = ("HIGH", "MEDIUM", "LOW")
REVIEWED = ("ESCALATED", "DISMISSED", "NEEDS_EVIDENCE")


@router.get("/dashboard")
def dashboard() -> dict:
    with connect() as conn:
        count = lambda sql, *p: conn.execute(sql, p).fetchone()[0]  # noqa: E731
        tx_by_band = {b: 0 for b in BANDS}
        for r in conn.execute("SELECT risk_band, COUNT(*) AS n FROM risk_assessments GROUP BY risk_band"):
            tx_by_band[r["risk_band"]] = r["n"]
        case_by_band = {b: 0 for b in BANDS}
        for r in conn.execute("SELECT risk_band, COUNT(*) AS n FROM cases WHERE active = 1 GROUP BY risk_band"):
            case_by_band[r["risk_band"]] = r["n"]
        case_by_status = {}
        for r in conn.execute("SELECT status, COUNT(*) AS n FROM cases WHERE active = 1 GROUP BY status"):
            case_by_status[r["status"]] = r["n"]

        queue = []
        for r in conn.execute(
            "SELECT case_id, title, status, risk_score, risk_band, transaction_ids_json, accounts_json, signal_codes_json, "
            "updated_at FROM cases WHERE active = 1 ORDER BY (status = 'OPEN') DESC, risk_score DESC, updated_at DESC, "
            "case_id LIMIT 8"
        ):
            d = dict(r)
            tx_ids = json.loads(d.pop("transaction_ids_json"))
            d["transaction_count"] = len(tx_ids)
            d["account_count"] = len(json.loads(d.pop("accounts_json")))
            d["signal_codes"] = json.loads(d.pop("signal_codes_json"))
            marks = ",".join("?" * len(tx_ids))
            agg = conn.execute(f"SELECT COALESCE(SUM(amount), 0) AS total, MIN(timestamp) AS first FROM transactions "
                               f"WHERE transaction_id IN ({marks})", tx_ids).fetchone()
            origin = conn.execute(
                f"SELECT a.holder_name FROM transactions t LEFT JOIN accounts a ON a.account_id = t.source_account "
                f"WHERE t.transaction_id IN ({marks}) ORDER BY t.timestamp, t.transaction_id LIMIT 1", tx_ids).fetchone()
            d["total_amount"] = agg["total"]
            d["first_activity"] = agg["first"]
            d["origin_name"] = origin["holder_name"] if origin else None
            queue.append(d)

        last_run = row_to_dict(conn.execute(
            "SELECT analysis_id, params_json, transactions_analyzed, rule_version, created_at FROM analysis_runs "
            "ORDER BY created_at DESC, analysis_id DESC LIMIT 1").fetchone())
        if last_run:
            last_run["params"] = json.loads(last_run.pop("params_json"))

        # Daily activity: all transfers vs. flagged (MEDIUM+) transfers.
        by_day = [dict(r) for r in conn.execute(
            "SELECT substr(t.timestamp, 1, 10) AS day, COUNT(*) AS transactions, SUM(t.amount) AS volume, "
            "SUM(CASE WHEN ra.score >= ? THEN 1 ELSE 0 END) AS flagged, "
            "SUM(CASE WHEN ra.score >= ? THEN t.amount ELSE 0 END) AS flagged_amount "
            "FROM transactions t LEFT JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id "
            "GROUP BY day ORDER BY day", (CASE_MIN_SCORE, CASE_MIN_SCORE))]

        signal_counts: dict[str, int] = {}
        for r in conn.execute("SELECT signals_json FROM risk_assessments WHERE score >= ?", (CASE_MIN_SCORE,)):
            for s in json.loads(r["signals_json"]):
                signal_counts[s["code"]] = signal_counts.get(s["code"], 0) + 1
        top_signals = [{"code": c, "label": LABELS.get(c, c), "count": n}
                       for c, n in sorted(signal_counts.items(), key=lambda kv: (-kv[1], kv[0]))]

        activity = []
        for r in conn.execute(
            "SELECT e.event_id, e.case_id, e.event_type, e.actor_type, e.event_payload, e.created_at, c.title "
            "FROM audit_events e LEFT JOIN cases c ON c.case_id = e.case_id "
            "WHERE e.event_type IN ('ANALYST_DECISION', 'AI_INVESTIGATION', 'AI_CHAT', 'ANALYSIS_RUN', "
            "'SYNTHETIC_TX_ADDED', 'CASE_UPDATED', 'AI_REPORT', 'MITIGATION_ACTION_APPROVED', 'MITIGATION_ACTION_CLOSED', "
            "'TRANSFER_HELD', 'TRANSFER_FLAGGED', 'HELD_TRANSFER_RESOLVED') ORDER BY e.event_id DESC LIMIT 8"
        ):
            d = dict(r)
            d["event_payload"] = json.loads(d["event_payload"])
            activity.append(d)

        flagged_amount = count(
            "SELECT COALESCE(SUM(t.amount), 0) FROM transactions t JOIN risk_assessments ra "
            "ON ra.transaction_id = t.transaction_id WHERE ra.score >= ?", CASE_MIN_SCORE)
        active_cases = count("SELECT COUNT(*) FROM cases WHERE active = 1")
        reviewed = sum(case_by_status.get(s, 0) for s in REVIEWED)

        # Where the flagged money moved: by payment channel.
        by_channel = [dict(r) for r in conn.execute(
            "SELECT t.channel, COUNT(*) AS transfers, "
            "SUM(CASE WHEN ra.score >= ? THEN 1 ELSE 0 END) AS flagged, "
            "SUM(CASE WHEN ra.score >= ? THEN t.amount ELSE 0 END) AS flagged_amount "
            "FROM transactions t LEFT JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id "
            "GROUP BY t.channel ORDER BY flagged_amount DESC, transfers DESC", (CASE_MIN_SCORE, CASE_MIN_SCORE))]

        # Accounts appearing most in flagged transfers (either side), highest score first.
        top_accounts = [dict(r) for r in conn.execute(
            "SELECT x.acc AS account_id, a.holder_name, a.account_type, a.city, a.kyc_tier, COUNT(*) AS flagged_transfers, "
            "SUM(x.amount) AS flagged_amount, MAX(x.score) AS max_score FROM ("
            " SELECT t.source_account AS acc, t.amount, ra.score FROM transactions t JOIN risk_assessments ra "
            " ON ra.transaction_id = t.transaction_id WHERE ra.score >= ?"
            " UNION ALL SELECT t.destination_account AS acc, t.amount, ra.score FROM transactions t JOIN risk_assessments ra "
            " ON ra.transaction_id = t.transaction_id WHERE ra.score >= ?) x "
            "LEFT JOIN accounts a ON a.account_id = x.acc GROUP BY x.acc "
            "ORDER BY max_score DESC, flagged_amount DESC, x.acc LIMIT 6", (CASE_MIN_SCORE, CASE_MIN_SCORE))]

        # AI assurance: how often Gemini answered and how its citations held up under validation.
        ai = {"answered": 0, "unavailable": 0, "citations_total": 0, "citations_valid": 0, "references_removed": 0,
              "reports": 0, "follow_ups": 0, "investigations": 0}
        for r in conn.execute("SELECT kind, status, result_json FROM ai_investigations"):
            if r["status"] != "OK":
                ai["unavailable"] += 1
                continue
            ai["answered"] += 1
            ai[{"REPORT": "reports", "CHAT": "follow_ups"}.get(r["kind"], "investigations")] += 1
            validation = json.loads(r["result_json"]).get("validation") or {}
            ai["citations_total"] += validation.get("total_citations") or 0
            ai["citations_valid"] += validation.get("valid_citations") or 0
            ai["references_removed"] += len(validation.get("removed_ids") or []) + len(validation.get("removed_accounts") or [])
        documents = {r["verdict"] or "NOT_ANALYSED": r["n"] for r in conn.execute(
            "SELECT verdict, COUNT(*) AS n FROM case_documents GROUP BY verdict")}
        ai["documents_checked"] = sum(documents.values())
        ai["documents_by_verdict"] = documents

        # Workflow pipeline, from monitored transfers down to approved actions.
        pipeline = [
            {"stage": "Transfers monitored", "value": count("SELECT COUNT(*) FROM transactions")},
            {"stage": "Flagged by rules", "value": tx_by_band["HIGH"] + tx_by_band["MEDIUM"]},
            {"stage": "Cases opened", "value": active_cases},
            {"stage": "Explained by AI", "value": count(
                "SELECT COUNT(DISTINCT i.case_id) FROM ai_investigations i JOIN cases c ON c.case_id = i.case_id "
                "WHERE i.status = 'OK' AND c.active = 1")},
            {"stage": "Reviewed by an analyst", "value": reviewed},
            {"stage": "With approved actions", "value": count(
                "SELECT COUNT(DISTINCT m.case_id) FROM mitigation_actions m JOIN cases c ON c.case_id = m.case_id "
                "WHERE c.active = 1")},
        ]
        actions_approved = count("SELECT COUNT(*) FROM mitigation_actions")

        # Mitigation in force: controls on accounts, what they stopped, and follow-up tasks.
        controls = mitigation.active_controls(conn, [r[0] for r in conn.execute(
            "SELECT DISTINCT target_account FROM mitigation_actions WHERE status = 'ACTIVE' AND target_account IS NOT NULL")])
        stopped = {r["status"]: {"count": r["n"], "amount": r["total"]} for r in conn.execute(
            "SELECT tc.status, COUNT(*) AS n, COALESCE(SUM(t.amount), 0) AS total FROM transfer_controls tc "
            "JOIN transactions t ON t.transaction_id = tc.transaction_id GROUP BY tc.status")}
        none = {"count": 0, "amount": 0}
        mitigation_summary = {
            "accounts_on_hold": len({c["target_account"] for c in controls if c["action_code"] == "HOLD_FOR_REVIEW"}),
            "accounts_monitored": len({c["target_account"] for c in controls if c["action_code"] == "ENHANCED_MONITORING"}),
            "held": stopped.get("HELD", none),
            "rejected": stopped.get("REJECTED", none),
            "released": stopped.get("RELEASED", none),
            "flagged": stopped.get("FLAGGED", none),
            "tasks_open": count("SELECT COUNT(*) FROM mitigation_actions WHERE status = 'OPEN'"),
            "tasks_completed": count(
                "SELECT COUNT(*) FROM mitigation_actions WHERE status = 'COMPLETED' AND action_code != 'NO_ACTION'"),
        }

        return {
            "mitigation": mitigation_summary,
            "by_channel": by_channel,
            "top_accounts": top_accounts,
            "ai": ai,
            "pipeline": pipeline,
            "actions_approved": actions_approved,
            "dataset_version": get_meta(conn, "dataset_version"),
            "reset_at": get_meta(conn, "reset_at"),
            "totals": {
                "transactions": count("SELECT COUNT(*) FROM transactions"),
                "accounts": count("SELECT COUNT(*) FROM accounts"),
                "synthetic_added": count("SELECT COUNT(*) FROM transactions WHERE is_synthetic_added = 1"),
                "cases": active_cases,
                "open_cases": case_by_status.get("OPEN", 0),
                "reviewed_cases": reviewed,
                "decisions": count("SELECT COUNT(*) FROM analyst_decisions"),
                "flagged_transactions": tx_by_band["HIGH"] + tx_by_band["MEDIUM"],
                "flagged_amount": flagged_amount,
                "total_volume": count("SELECT COALESCE(SUM(amount), 0) FROM transactions"),
            },
            "transactions_by_band": tx_by_band,
            "cases_by_band": case_by_band,
            "cases_by_status": case_by_status,
            "recent_cases": queue,
            "activity_by_day": by_day,
            "top_signals": top_signals,
            "recent_activity": activity,
            "last_analysis": last_run,
        }
