import json

from fastapi import APIRouter, Query

from backend.db import connect

router = APIRouter(tags=["audit"])

WORKSPACE = "WORKSPACE"  # filter value for events not tied to a case (analysis runs, resets, portfolio AI)


@router.get("/audit")
def audit_log(
    case_id: str | None = Query(default=None, max_length=64),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    """The full audit trail, newest first, each event with the title of the case it belongs to."""
    if case_id == WORKSPACE:
        clause, params = "WHERE e.case_id IS NULL", []
    elif case_id:
        clause, params = "WHERE e.case_id = ?", [case_id]
    else:
        clause, params = "", []
    with connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM audit_events e {clause}", params).fetchone()[0]
        items = []
        for r in conn.execute(
            f"SELECT e.*, c.title FROM audit_events e LEFT JOIN cases c ON c.case_id = e.case_id {clause} "
            f"ORDER BY e.event_id DESC LIMIT ? OFFSET ?", (*params, page_size, (page - 1) * page_size)):
            d = dict(r)
            d["event_payload"] = json.loads(d["event_payload"])
            items.append(d)
        # Filter options: every case with at least one audit event, most recently audited first.
        cases = [dict(r) for r in conn.execute(
            "SELECT e.case_id, c.title, COUNT(*) AS events, MAX(e.event_id) AS last_event_id FROM audit_events e "
            "LEFT JOIN cases c ON c.case_id = e.case_id WHERE e.case_id IS NOT NULL "
            "GROUP BY e.case_id ORDER BY last_event_id DESC")]
        workspace_events = conn.execute("SELECT COUNT(*) FROM audit_events WHERE case_id IS NULL").fetchone()[0]
        last = conn.execute(
            "SELECT e.case_id, e.event_payload, e.created_at, c.title FROM audit_events e "
            "LEFT JOIN cases c ON c.case_id = e.case_id WHERE e.event_type = 'AI_GUARDRAIL_TEST' "
            "ORDER BY e.event_id DESC LIMIT 1").fetchone()
    for c in cases:
        c.pop("last_event_id")
    last_guardrail_test = None
    if last:
        last_guardrail_test = {"case_id": last["case_id"], "title": last["title"], "created_at": last["created_at"],
                               **json.loads(last["event_payload"])}
    return {"items": items, "total": total, "page": page, "page_size": page_size,
            "cases": cases, "workspace_events": workspace_events, "last_guardrail_test": last_guardrail_test}
