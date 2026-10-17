"""Event-driven ingest through Pub/Sub.

Producers publish a transfer as a JSON message on PUBSUB_TOPIC. A push subscription delivers it to
POST /api/cloud/stream/push on Cloud Run, which validates it, records it, enforces any hold or monitoring control,
re-scores the workspace and logs the end-to-end latency. Delivery is at-least-once, so the transfer ID is
assigned at publish time and a redelivered message is acknowledged as a duplicate instead of being recorded twice.
"""
import base64
import json
import logging
from datetime import datetime, timezone

from backend.config import settings
from backend.db import connect, get_meta, set_meta, utcnow

logger = logging.getLogger("fraudgraph.pubsub")

_publisher = None


def enabled() -> bool:
    return bool(settings.pubsub_topic and settings.google_cloud_project)


def topic_path() -> str:
    return f"projects/{settings.google_cloud_project}/topics/{settings.pubsub_topic}"


def next_transaction_id() -> str:
    """Reserve an ID before publishing so redeliveries are idempotent (TX-D100001, TX-D100002, ...)."""
    with connect() as conn:
        seq = int(get_meta(conn, "stream_seq") or 100000) + 1
        while conn.execute("SELECT 1 FROM transactions WHERE transaction_id = ?", (f"TX-D{seq}",)).fetchone():
            seq += 1
        set_meta(conn, "stream_seq", str(seq))
    return f"TX-D{seq}"


def publish(payload: dict) -> str:
    global _publisher
    from google.cloud import pubsub_v1

    if _publisher is None:
        _publisher = pubsub_v1.PublisherClient()
    data = json.dumps(payload, separators=(",", ":")).encode()
    future = _publisher.publish(topic_path(), data, origin="fraudgraph-console", published_at=utcnow())
    return future.result(timeout=15)


def decode_push(envelope: dict) -> tuple[str, dict, str | None]:
    """(message_id, payload, publish_time) from a Pub/Sub push envelope. Raises ValueError when malformed."""
    message = (envelope or {}).get("message") or {}
    message_id = str(message.get("messageId") or message.get("message_id") or "")
    if not message_id:
        raise ValueError("Missing messageId.")
    try:
        payload = json.loads(base64.b64decode(message.get("data") or "", validate=True))
    except (ValueError, TypeError) as exc:
        raise ValueError("Message data is not base64-encoded JSON.") from exc
    if not isinstance(payload, dict):
        raise ValueError("Message data must be a JSON object.")
    return message_id, payload, message.get("publishTime") or message.get("publish_time")


def latency_ms(publish_time: str | None) -> int | None:
    if not publish_time:
        return None
    try:
        sent = datetime.fromisoformat(publish_time.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0, int((datetime.now(timezone.utc) - sent).total_seconds() * 1000))


def record(message_id: str, transaction_id: str | None, status: str, detail: str | None,
           publish_time: str | None) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO stream_events(message_id, transaction_id, status, detail, published_at, processed_at, "
            "latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (message_id, transaction_id, status, (detail or "")[:300] or None, publish_time, utcnow(),
             latency_ms(publish_time)))


def already_processed(message_id: str) -> bool:
    with connect() as conn:
        return conn.execute("SELECT 1 FROM stream_events WHERE message_id = ?", (message_id,)).fetchone() is not None


def recent(limit: int = 20) -> list[dict]:
    with connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT e.*, ra.score, ra.risk_band FROM stream_events e "
            "LEFT JOIN risk_assessments ra ON ra.transaction_id = e.transaction_id "
            "ORDER BY e.processed_at DESC, e.message_id DESC LIMIT ?", (limit,))]
