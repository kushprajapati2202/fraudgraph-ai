"""Personal "Recommended for you" list on the dashboard."""
from datetime import datetime, timedelta, timezone

from backend.db import connect
from backend.services.recommendations import MAX_ITEMS


def _recs(client, analyst=None):
    res = client.get("/api/recommendations", params={"analyst": analyst} if analyst else {})
    assert res.status_code == 200
    return res.json()


def _layered(client):
    scen = client.get("/api/demo/scenarios").json()["scenarios"]
    case_id = next(s for s in scen if s["scenario_id"] == "layered-transfer-01")["case_ids"][0]
    return client.get(f"/api/cases/{case_id}").json()


def _hold_target(detail):
    return next(s for s in detail["suggested_actions"] if s["action_code"] == "HOLD_FOR_REVIEW")["target_account"]


def _kinds(recs):
    return [i["kind"] for i in recs["items"]]


def test_default_name_gets_team_wide_unreviewed_cases(client):
    for analyst in (None, "Analyst"):
        recs = _recs(client, analyst)
        assert recs["personalized"] is False and recs["analyst"] is None
        assert recs["items"] and set(_kinds(recs)) == {"HIGH_RISK_UNREVIEWED"}
        scores = [i["risk_score"] for i in recs["items"]]
        assert scores == sorted(scores, reverse=True)


def test_list_is_capped_and_never_repeats_a_case(client):
    for analyst in (None, "Priya"):
        items = _recs(client, analyst)["items"]
        assert len(items) <= MAX_ITEMS
        assert len({i["case_id"] for i in items}) == len(items)
        assert all(i["title"] and i["reason"] for i in items)


def test_overdue_task_shows_first_and_only_for_its_approver(client):
    detail = _layered(client)
    cid, acc = detail["case"]["case_id"], detail["case"]["accounts"][0]
    res = client.post(f"/api/cases/{cid}/actions", json={
        "action_code": "REQUEST_CUSTOMER_VERIFICATION", "target_account": acc, "source": "PLAYBOOK", "actor_label": "Priya"})
    action_id = res.json()["action"]["action_id"]

    first = _recs(client, "Priya")["items"][0]
    assert first["kind"] == "TASK_DUE_SOON" and first["case_id"] == cid  # 2-day SLA: due soon, not overdue yet

    old = (datetime.now(timezone.utc) - timedelta(days=4)).replace(microsecond=0).isoformat()
    with connect() as conn:
        conn.execute("UPDATE mitigation_actions SET created_at = ? WHERE action_id = ?", (old, action_id))
    recs = _recs(client, "Priya")
    assert recs["personalized"] is True and recs["analyst"] == "Priya"
    first = recs["items"][0]
    assert first["kind"] == "OVERDUE_TASK" and first["case_id"] == cid and first["account_id"] == acc
    assert "due 2 days ago" in first["reason"]
    assert "OVERDUE_TASK" not in _kinds(_recs(client, "Sam"))


def test_held_transfers_are_counted_on_the_approvers_list(client):
    detail = _layered(client)
    cid, acc = detail["case"]["case_id"], _hold_target(detail)
    client.post(f"/api/cases/{cid}/actions", json={"action_code": "HOLD_FOR_REVIEW", "target_account": acc,
                                                   "actor_label": "Priya"})
    for amount in (40_000, 60_000):
        res = client.post("/api/transactions/demo", json={"source_account": acc, "destination_account": "AC-901",
                                                          "amount": amount})
        assert res.json()["control"]["status"] == "HELD"

    held = next(i for i in _recs(client, "Priya")["items"] if i["kind"] == "HELD_TRANSFERS")
    assert held["count"] == 2 and held["amount"] == 100_000 and held["account_id"] == acc
    assert "your hold" in held["title"]
    assert "HELD_TRANSFERS" not in _kinds(_recs(client, "Sam"))
    assert "HELD_TRANSFERS" in _kinds(_recs(client))  # team-wide list shows every hold


def test_more_evidence_request_becomes_a_follow_up(client):
    cid = _layered(client)["case"]["case_id"]
    client.post(f"/api/cases/{cid}/decision", json={"decision": "REQUEST_MORE_EVIDENCE",
                                                    "rationale": "Waiting for invoice", "actor_label": "Priya"})
    follow = [i for i in _recs(client, "Priya")["items"] if i["kind"] == "FOLLOW_UP"]
    assert [i["case_id"] for i in follow] == [cid]
    assert "You asked for more evidence today" in follow[0]["reason"]
    assert cid not in {i["case_id"] for i in _recs(client, "Sam")["items"]}  # no longer an unreviewed case


def test_similar_cases_point_back_to_an_escalated_case(client):
    cid = _layered(client)["case"]["case_id"]
    client.post(f"/api/cases/{cid}/decision", json={"decision": "ESCALATE_FOR_REVIEW",
                                                    "rationale": "Layered movement", "actor_label": "Priya"})
    items = _recs(client, "Priya")["items"]
    assert cid not in {i["case_id"] for i in items}
    for i in items:
        if i["kind"] == "SIMILAR_TO_ESCALATED":
            assert i["similar_case_id"] == cid and "warning signs" in i["reason"]


def test_invalid_analyst_name_is_rejected(client):
    assert client.get("/api/recommendations", params={"analyst": "<script>"}).status_code == 422
    assert client.get("/api/recommendations", params={"analyst": "x" * 61}).status_code == 422
