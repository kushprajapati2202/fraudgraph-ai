"""Durable state on Cloud Run: the SQLite file is mirrored to a Cloud Storage object.

On startup the latest snapshot is restored before the schema is checked; after each successful write request a
debounced backup uploads a consistent copy (SQLite online backup API). Off unless GCS_STATE_BUCKET is set.
"""
import logging
import os
import sqlite3
import tempfile
import threading
from pathlib import Path

from backend.config import settings
from backend.db import utcnow

logger = logging.getLogger("fraudgraph.state_sync")

OBJECT_NAME = "state/fraudgraph.db"
DEBOUNCE_SECONDS = 2.0

_lock = threading.Lock()
_timer: threading.Timer | None = None
status: dict = {"last_restore": None, "last_backup": None, "backups": 0, "error": None}


def enabled() -> bool:
    return bool(settings.gcs_state_bucket)


def _blob():
    from google.cloud import storage

    client = storage.Client(project=settings.google_cloud_project)
    return client.bucket(settings.gcs_state_bucket).blob(OBJECT_NAME)


def restore() -> bool:
    """Download the last snapshot over the local database. Returns True when one was restored."""
    if not enabled():
        return False
    try:
        blob = _blob()
        if not blob.exists():
            logger.info("No state snapshot in gs://%s yet; starting from the baseline", settings.gcs_state_bucket)
            return False
        path = Path(settings.resolved_db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(str(path))
        status["last_restore"] = utcnow()
        logger.info("Restored state snapshot from gs://%s/%s", settings.gcs_state_bucket, OBJECT_NAME)
        return True
    except Exception as exc:  # never block startup on storage
        status["error"] = f"restore: {type(exc).__name__}"
        logger.warning("State restore failed: %s", exc)
        return False


def backup_now() -> bool:
    if not enabled():
        return False
    with _lock:
        fd, tmp = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            src = sqlite3.connect(settings.resolved_db_path, timeout=10)
            dst = sqlite3.connect(tmp)
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
            _blob().upload_from_filename(tmp, content_type="application/vnd.sqlite3")
            status["last_backup"] = utcnow()
            status["backups"] += 1
            status["error"] = None
            return True
        except Exception as exc:
            status["error"] = f"backup: {type(exc).__name__}"
            logger.warning("State backup failed: %s", exc)
            return False
        finally:
            Path(tmp).unlink(missing_ok=True)


def schedule_backup() -> None:
    """Coalesce bursts of writes into one upload a couple of seconds after the last one."""
    global _timer
    if not enabled():
        return
    with _lock:
        if _timer is not None:
            _timer.cancel()
        _timer = threading.Timer(DEBOUNCE_SECONDS, backup_now)
        _timer.daemon = True
        _timer.start()


def flush() -> None:
    """Upload any pending change now (called on shutdown, when Cloud Run sends SIGTERM)."""
    global _timer
    if not enabled():
        return
    with _lock:
        pending = _timer is not None and _timer.is_alive()
        if _timer is not None:
            _timer.cancel()
            _timer = None
    if pending:
        backup_now()
