"""BigQuery analytics mirror: the workspace tables are copied into a BigQuery dataset for portfolio analytics,
natural-language SQL (bigquery_ask) and the BigQuery ML model (bigquery_ml).

SQLite stays the system of record for the app; BigQuery holds a read-only copy refreshed by free load jobs
(WRITE_TRUNCATE) a few seconds after changes. Off unless BIGQUERY_DATASET and GOOGLE_CLOUD_PROJECT are set.
"""
import json
import logging
import threading

from backend.config import settings
from backend.db import connect, utcnow

logger = logging.getLogger("fraudgraph.bigquery")

DEBOUNCE_SECONDS = 15.0

S, I, F, B, D, T = "STRING", "INT64", "FLOAT64", "BOOL", "DATE", "TIMESTAMP"

# table -> [(column, type, mode, description)]; the descriptions are also what Gemini sees when writing SQL.
TABLES: dict[str, list[tuple[str, str, str, str]]] = {
    "accounts": [
        ("account_id", S, "REQUIRED", "Account ID such as AC-101"),
        ("holder_name", S, "NULLABLE", "Fictional account holder name"),
        ("account_type", S, "NULLABLE", "PERSONAL or BUSINESS"),
        ("opened_on", D, "NULLABLE", "Date the account was opened"),
        ("city", S, "NULLABLE", "Home branch city"),
        ("kyc_tier", S, "NULLABLE", "FULL_KYC or MIN_KYC"),
    ],
    "transfers": [
        ("transaction_id", S, "REQUIRED", "Transfer ID such as TX-1001"),
        ("source_account", S, "REQUIRED", "Sending account_id"),
        ("destination_account", S, "REQUIRED", "Receiving account_id"),
        ("amount", F, "REQUIRED", "Amount in INR"),
        ("ts", T, "REQUIRED", "Transfer time (UTC)"),
        ("channel", S, "NULLABLE", "UPI, IMPS, NEFT, CARD or WALLET"),
        ("device_id", S, "NULLABLE", "Device used to initiate the transfer"),
        ("risk_score", I, "NULLABLE", "Rule-based priority score 0-100 (not a probability)"),
        ("risk_band", S, "NULLABLE", "LOW, MEDIUM or HIGH"),
        ("signal_codes", S, "REPEATED", "Rule signals that fired: UNUSUAL_AMOUNT, VELOCITY, RAPID_ONWARD, "
                                         "FAN_IN_RAPID_OUT, RELATIONSHIP_NOVELTY, SHARED_DEVICE"),
        ("control_status", S, "NULLABLE", "Control applied on arrival: HELD, RELEASED, REJECTED, FLAGGED or NULL"),
        ("added_live", B, "NULLABLE", "True when the transfer arrived after the baseline load"),
    ],
    "cases": [
        ("case_id", S, "REQUIRED", "Case ID such as CASE-AB12CD"),
        ("title", S, "NULLABLE", "Case title"),
        ("status", S, "NULLABLE", "OPEN, ESCALATED, DISMISSED or NEEDS_EVIDENCE"),
        ("risk_score", I, "NULLABLE", "Case priority score 0-100"),
        ("risk_band", S, "NULLABLE", "LOW, MEDIUM or HIGH"),
        ("accounts", S, "REPEATED", "Account IDs in the case"),
        ("transaction_ids", S, "REPEATED", "Transfer IDs in the case"),
        ("signal_codes", S, "REPEATED", "Rule signals present in the case"),
        ("total_amount", F, "NULLABLE", "Sum of the case's transfers in INR"),
        ("created_at", T, "NULLABLE", "When the case was first created"),
        ("updated_at", T, "NULLABLE", "Last analysis update"),
    ],
    "decisions": [
        ("case_id", S, "REQUIRED", "Case ID"),
        ("decision", S, "REQUIRED", "ESCALATE, DISMISS or NEEDS_EVIDENCE"),
        ("analyst", S, "NULLABLE", "Analyst name"),
        ("decided_at", T, "NULLABLE", "Decision time"),
    ],
    "mitigation_actions": [
        ("action_id", I, "REQUIRED", "Action ID"),
        ("case_id", S, "REQUIRED", "Case ID"),
        ("action_code", S, "REQUIRED", "HOLD_FOR_REVIEW, ENHANCED_MONITORING, CUSTOMER_VERIFICATION, ..."),
        ("target_account", S, "NULLABLE", "Account the action applies to"),
        ("status", S, "NULLABLE", "ACTIVE, OPEN, COMPLETED, LIFTED or REJECTED"),
        ("approved_by", S, "NULLABLE", "Analyst who approved it"),
        ("created_at", T, "NULLABLE", "Approval time"),
        ("closed_at", T, "NULLABLE", "When it was lifted or completed"),
    ],
    "labels": [
        ("transaction_id", S, "REQUIRED", "Transfer ID"),
        ("scenario_id", S, "NULLABLE", "Synthetic scenario the transfer belongs to"),
        ("label", S, "NULLABLE", "Ground truth for evaluation: SUSPICIOUS, LEGIT or UNLABELED"),
    ],
}

_lock = threading.Lock()
_timer: threading.Timer | None = None
status: dict = {"last_sync": None, "rows": {}, "error": None, "syncs": 0}


def enabled() -> bool:
    return bool(settings.bigquery_dataset and settings.google_cloud_project)


def dataset_ref() -> str:
    return f"{settings.google_cloud_project}.{settings.bigquery_dataset}"


def client():
    from google.cloud import bigquery

    return bigquery.Client(project=settings.google_cloud_project, location=settings.bigquery_location)


def _ts(value: str | None) -> str | None:
    if not value:
        return None
    value = value.replace("Z", "+00:00")
    return value if "+" in value[10:] else value + "+00:00"


def snapshot_rows(conn) -> dict[str, list[dict]]:
    """Current workspace state shaped for the BigQuery tables (pure; tested without BigQuery)."""
    controls = {r["transaction_id"]: r["status"] for r in conn.execute("SELECT transaction_id, status FROM transfer_controls")}
    scores = {r["transaction_id"]: r for r in conn.execute("SELECT transaction_id, score, risk_band, signals_json FROM risk_assessments")}
    amounts = {r["transaction_id"]: r["amount"] for r in conn.execute("SELECT transaction_id, amount FROM transactions")}
    out: dict[str, list[dict]] = {
        "accounts": [{"account_id": r["account_id"], "holder_name": r["holder_name"], "account_type": r["account_type"],
                      "opened_on": (r["created_at"] or "")[:10] or None, "city": r["city"], "kyc_tier": r["kyc_tier"]}
                     for r in conn.execute("SELECT * FROM accounts")],
        "transfers": [],
        "cases": [],
        "decisions": [{"case_id": r["case_id"], "decision": r["decision"], "analyst": r["actor_label"],
                       "decided_at": _ts(r["created_at"])} for r in conn.execute("SELECT * FROM analyst_decisions")],
        "mitigation_actions": [{"action_id": r["action_id"], "case_id": r["case_id"], "action_code": r["action_code"],
                                "target_account": r["target_account"], "status": r["status"], "approved_by": r["actor_label"],
                                "created_at": _ts(r["created_at"]), "closed_at": _ts(r["closed_at"])}
                               for r in conn.execute("SELECT * FROM mitigation_actions")],
        "labels": [dict(r) for r in conn.execute("SELECT transaction_id, scenario_id, label FROM labels")],
    }
    for r in conn.execute("SELECT * FROM transactions"):
        ra = scores.get(r["transaction_id"])
        out["transfers"].append({
            "transaction_id": r["transaction_id"], "source_account": r["source_account"],
            "destination_account": r["destination_account"], "amount": r["amount"], "ts": _ts(r["timestamp"]),
            "channel": r["channel"], "device_id": r["device_id"],
            "risk_score": ra["score"] if ra else None, "risk_band": ra["risk_band"] if ra else None,
            "signal_codes": [s["code"] for s in json.loads(ra["signals_json"])] if ra else [],
            "control_status": controls.get(r["transaction_id"]), "added_live": bool(r["is_synthetic_added"])})
    for r in conn.execute("SELECT * FROM cases WHERE active = 1"):
        tx_ids = json.loads(r["transaction_ids_json"])
        out["cases"].append({
            "case_id": r["case_id"], "title": r["title"], "status": r["status"], "risk_score": r["risk_score"],
            "risk_band": r["risk_band"], "accounts": json.loads(r["accounts_json"]), "transaction_ids": tx_ids,
            "signal_codes": json.loads(r["signal_codes_json"]),
            "total_amount": round(sum(amounts.get(t, 0) for t in tx_ids), 2),
            "created_at": _ts(r["created_at"]), "updated_at": _ts(r["updated_at"])})
    return out


def _schema(table: str):
    from google.cloud import bigquery

    return [bigquery.SchemaField(n, t, mode=m, description=d) for n, t, m, d in TABLES[table]]


def ensure_dataset() -> None:
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery

    try:  # the deploy script creates it; the service account only has dataset-level access
        client().get_dataset(dataset_ref())
        return
    except NotFound:
        pass
    ds = bigquery.Dataset(dataset_ref())
    ds.location = settings.bigquery_location
    ds.description = "FraudGraph AI analytics mirror (synthetic data)."
    client().create_dataset(ds, exists_ok=True)


def sync_now() -> dict:
    """Load every table with WRITE_TRUNCATE. Returns row counts per table."""
    if not enabled():
        return {}
    from google.cloud import bigquery

    with _lock:
        try:
            with connect() as conn:
                rows = snapshot_rows(conn)
            bq = client()
            ensure_dataset()
            jobs = []
            for table, data in rows.items():
                config = bigquery.LoadJobConfig(schema=_schema(table), write_disposition="WRITE_TRUNCATE",
                                                source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON)
                jobs.append(bq.load_table_from_json(data, f"{dataset_ref()}.{table}", job_config=config))
            for job in jobs:
                job.result(timeout=120)
            status.update(last_sync=utcnow(), rows={t: len(d) for t, d in rows.items()}, error=None)
            status["syncs"] += 1
            logger.info("BigQuery sync complete: %s", status["rows"])
        except Exception as exc:
            status["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
            logger.warning("BigQuery sync failed: %s", exc)
            return {}
    # New or rescored transfers: refresh the BigQuery ML scores if a model has been trained.
    from backend.services import bigquery_ml

    bigquery_ml.score_if_trained()
    return status["rows"]


def schedule_sync() -> None:
    global _timer
    if not enabled():
        return
    if _timer is not None:
        _timer.cancel()
    _timer = threading.Timer(DEBOUNCE_SECONDS, sync_now)
    _timer.daemon = True
    _timer.start()


def schema_for_prompt() -> str:
    """Compact table reference for the natural-language SQL prompt."""
    lines = []
    for table, cols in TABLES.items():
        lines.append(f"TABLE `{dataset_ref()}.{table}`")
        lines += [f"  {n} {('ARRAY<' + t + '>') if m == 'REPEATED' else t} -- {d}" for n, t, m, d in cols]
    return "\n".join(lines)
