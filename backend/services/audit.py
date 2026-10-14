import sqlite3

from backend.db import dumps, utcnow

ACTOR_SYSTEM = "SYSTEM"
ACTOR_AI = "AI"
ACTOR_HUMAN = "HUMAN"


def record(conn: sqlite3.Connection, event_type: str, actor_type: str, payload: dict, case_id: str | None = None) -> None:
    conn.execute(
        "INSERT INTO audit_events(case_id, event_type, actor_type, event_payload, created_at) VALUES (?, ?, ?, ?, ?)",
        (case_id, event_type, actor_type, dumps(payload), utcnow()),
    )
