"""SQLite persistence. Short-lived demo storage; `reset` restores the deterministic baseline."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from backend.config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    account_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    demo_label TEXT NOT NULL,
    holder_name TEXT,
    account_number TEXT,
    city TEXT,
    branch_code TEXT,
    kyc_tier TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    source_account TEXT NOT NULL,
    destination_account TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount >= 0),
    currency TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    channel TEXT NOT NULL,
    device_id TEXT,
    description TEXT,
    reference TEXT,
    is_synthetic_added INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tx_source ON transactions(source_account);
CREATE INDEX IF NOT EXISTS ix_tx_dest ON transactions(destination_account);
CREATE INDEX IF NOT EXISTS ix_tx_ts ON transactions(timestamp);
CREATE TABLE IF NOT EXISTS labels (
    transaction_id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL,
    label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS risk_assessments (
    assessment_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL UNIQUE,
    score INTEGER NOT NULL,
    risk_band TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    uncertainties_json TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cases (
    case_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_score INTEGER NOT NULL,
    risk_band TEXT NOT NULL,
    transaction_ids_json TEXT NOT NULL,
    accounts_json TEXT NOT NULL,
    signal_codes_json TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    summary TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    analysis_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_evidence (
    case_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    description TEXT NOT NULL,
    timestamp TEXT,
    payload_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (case_id, evidence_id)
);
CREATE TABLE IF NOT EXISTS analyst_decisions (
    decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    actor_label TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mitigation_actions (
    action_id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    action_code TEXT NOT NULL,
    target_account TEXT,
    note TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT,
    outcome TEXT
);
CREATE TABLE IF NOT EXISTS transfer_controls (
    transaction_id TEXT PRIMARY KEY,
    action_id INTEGER NOT NULL,
    case_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    control TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS ix_tc_case ON transfer_controls(case_id);
CREATE TABLE IF NOT EXISTS embeddings (
    key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    vector_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_documents (
    document_id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    verdict TEXT,
    result_json TEXT NOT NULL,
    actor_label TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_investigations (
    investigation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT,
    prompt_version TEXT NOT NULL,
    question TEXT,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_insights (
    insight_id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    as_of_event_id INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_insights_scope ON ai_insights(scope, kind);
CREATE TABLE IF NOT EXISTS audit_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    event_payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analysis_runs (
    analysis_id TEXT PRIMARY KEY,
    params_json TEXT NOT NULL,
    transactions_analyzed INTEGER NOT NULL,
    cases_created INTEGER NOT NULL,
    rule_version TEXT NOT NULL,
    diff_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""

TABLES = [
    "meta", "accounts", "transactions", "labels", "risk_assessments", "cases",
    "case_evidence", "analyst_decisions", "mitigation_actions", "transfer_controls", "case_documents", "ai_investigations",
    "ai_insights", "audit_events", "analysis_runs",
]

# Columns added after a table first shipped; applied to databases created by an older build.
ADDED_COLUMNS = {"mitigation_actions": {"closed_at": "TEXT", "closed_by": "TEXT", "outcome": "TEXT"}}


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _connect() -> sqlite3.Connection:
    path = settings.resolved_db_path
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    for table, columns in ADDED_COLUMNS.items():
        present = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns.items():
            if name not in present:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    # Actions approved before they had a lifecycle were all stored as APPROVED.
    conn.execute(
        "UPDATE mitigation_actions SET status = CASE "
        "WHEN action_code IN ('HOLD_FOR_REVIEW', 'ENHANCED_MONITORING') THEN 'ACTIVE' "
        "WHEN action_code = 'NO_ACTION' THEN 'COMPLETED' ELSE 'OPEN' END WHERE status = 'APPROVED'")


def drop_all(conn: sqlite3.Connection) -> None:
    for table in TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {table}")


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
