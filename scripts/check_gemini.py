"""Diagnose the Gemini configuration without printing the key.

Usage: python scripts/check_gemini.py [--investigate]
  --investigate  also run one real structured investigation on the top case (uses a temporary database)
"""
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import settings  # noqa: E402
from backend.services import gemini_service  # noqa: E402


def main() -> int:
    result = gemini_service.check_connection(force=True, list_models=True)
    for key in ("configured", "connected", "key_format_ok", "category", "message", "detail", "active_model"):
        if result.get(key) is not None:
            print(f"{key:>14}: {result[key]}")
    for a in result.get("attempts", []):
        print(f"{'attempt':>14}: {a['model']} -> {a['category']} in {a['seconds']}s {a['detail'] or ''}")
    models = result.get("available_models") or []
    if models:
        print(f"{'usable models':>14}: {', '.join(models)}")
    if not result["connected"]:
        return 1

    if "--investigate" in sys.argv:
        from fastapi.testclient import TestClient

        settings.db_path = str(Path(tempfile.mkdtemp()) / "check.db")
        from backend.main import app

        with TestClient(app) as client:
            case_id = client.get("/api/cases").json()["items"][0]["case_id"]
            started = time.time()
            resp = client.post(f"/api/cases/{case_id}/investigate", json={}).json()["response"]
        print(f"{'investigation':>14}: {resp['status']} {resp.get('reason') or ''} model={resp.get('model')} "
              f"in {time.time() - started:.1f}s")
        if resp["status"] == "OK":
            v = resp["validation"]
            print(f"{'citations':>14}: {v['valid_citations']}/{v['total_citations']} valid, removed={v['removed_ids']}, "
                  f"unsupported={len(v['unsupported_claims'])}")
            print(f"{'summary':>14}: {resp['result']['case_summary'][:300]}")
        else:
            print(f"{'detail':>14}: {resp.get('detail')}")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
