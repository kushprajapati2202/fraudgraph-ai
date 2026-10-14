"""Mitigation playbook, AI escalation report validation, and human-approved actions."""
import json

from backend.services import gemini_service, mitigation


def _layered(client):
    scen = client.get("/api/demo/scenarios").json()["scenarios"]
    case_id = next(s for s in scen if s["scenario_id"] == "layered-transfer-01")["case_ids"][0]
    return client.get(f"/api/cases/{case_id}").json()


def test_playbook_suggestions_are_catalogue_actions_on_case_accounts(client):
    detail = _layered(client)
    suggestions = detail["suggested_actions"]
    codes = {s["action_code"] for s in suggestions}
    assert {"HOLD_FOR_REVIEW", "REQUEST_CUSTOMER_VERIFICATION", "FILE_INTERNAL_SUSPICION_REPORT", "KYC_REFRESH"} <= codes
    for s in suggestions:
        assert s["action_code"] in mitigation.ACTION_CATALOG and s["source"] == "PLAYBOOK" and s["rationale"]
        assert s["target_account"] is None or s["target_account"] in detail["case"]["accounts"]
    assert len(detail["action_catalog"]) == len(mitigation.ACTION_CATALOG)


def test_report_validation_removes_fabricated_ids_accounts_and_actions(client, monkeypatch):
    detail = _layered(client)
    cid = detail["case"]["case_id"]
    real = detail["evidence"][0]["evidence_id"]
    acc = detail["case"]["accounts"][0]
    fake = {
        "headline": "Layered movement",
        "executive_summary": f"Funds moved quickly ({real}); see also EV-TX-000000.",
        "subject_accounts": [{"account_id": acc, "role": "Origin", "evidence_ids": [real]},
                             {"account_id": "AC-999", "role": "Invented", "evidence_ids": [real]}],
        "chronology": [{"timestamp": "2026-09-18T14:02", "event": "First transfer", "evidence_ids": [real]},
                       {"timestamp": "2026-09-18T15:00", "event": "Invented event", "evidence_ids": ["EV-NOPE"]}],
        "suspicious_indicators": [{"text": "Rapid onward movement", "evidence_ids": [real]}],
        "mitigating_factors": ["Could be business payments"],
        "information_gaps": ["No customer contact yet"],
        "recommended_actions": [
            {"action_code": "HOLD_FOR_REVIEW", "target_account": acc, "rationale": "Keep funds reviewable", "evidence_ids": [real]},
            {"action_code": "KYC_REFRESH", "target_account": "AC-999", "rationale": "Not in case", "evidence_ids": [real]},
            {"action_code": "ENHANCED_MONITORING", "target_account": acc, "rationale": "No evidence", "evidence_ids": []},
        ],
    }
    monkeypatch.setattr(gemini_service, "generate_json", lambda *a, **k: json.dumps(fake))
    resp = client.post(f"/api/cases/{cid}/report").json()["response"]
    assert resp["status"] == "OK"
    result, validation = resp["result"], resp["validation"]
    assert [a["account_id"] for a in result["subject_accounts"]] == [acc]
    assert [e["event"] for e in result["chronology"]] == ["First transfer"]
    assert [a["action_code"] for a in result["recommended_actions"]] == ["HOLD_FOR_REVIEW"]
    assert "AC-999" in validation["removed_accounts"]
    assert {"EV-NOPE", "EV-TX-000000"} <= set(validation["removed_ids"])
    assert "EV-TX-000000" not in result["executive_summary"]
    # stored and returned with the case; report generation alone approves nothing
    after = client.get(f"/api/cases/{cid}").json()
    assert after["latest_report"]["response"]["status"] == "OK" and after["actions"] == []


def test_invalid_action_code_from_model_falls_back(client, monkeypatch):
    detail = _layered(client)
    bad = {"headline": "x", "executive_summary": "x", "subject_accounts": [], "chronology": [], "suspicious_indicators": [],
           "mitigating_factors": [], "information_gaps": [],
           "recommended_actions": [{"action_code": "FREEZE_ALL_ACCOUNTS", "target_account": "", "rationale": "x", "evidence_ids": []}]}
    monkeypatch.setattr(gemini_service, "generate_json", lambda *a, **k: json.dumps(bad))
    resp = client.post(f"/api/cases/{detail['case']['case_id']}/report").json()["response"]
    assert resp["status"] == "UNAVAILABLE" and resp["reason"] == "INVALID_SCHEMA"


def test_report_unavailable_keeps_playbook(client):
    detail = _layered(client)
    resp = client.post(f"/api/cases/{detail['case']['case_id']}/report").json()["response"]
    assert resp["status"] == "UNAVAILABLE"  # no key in tests
    assert client.get(f"/api/cases/{detail['case']['case_id']}").json()["suggested_actions"]


def test_human_approves_action_and_it_is_audited(client):
    detail = _layered(client)
    cid, acc = detail["case"]["case_id"], detail["case"]["accounts"][0]
    body = {"action_code": "HOLD_FOR_REVIEW", "target_account": acc, "source": "PLAYBOOK", "note": "Pending callback"}
    res = client.post(f"/api/cases/{cid}/actions", json=body)
    assert res.status_code == 201 and res.json()["action"]["status"] == "ACTIVE"
    assert client.post(f"/api/cases/{cid}/actions", json=body).status_code == 409  # no duplicates while in force
    after = client.get(f"/api/cases/{cid}").json()
    assert after["actions"][0]["action_code"] == "HOLD_FOR_REVIEW"
    event = [e for e in after["audit_events"] if e["event_type"] == "MITIGATION_ACTION_APPROVED"][-1]
    assert event["actor_type"] == "HUMAN" and event["event_payload"]["executed_externally"] is False


def test_action_validation(client):
    detail = _layered(client)
    cid = detail["case"]["case_id"]
    post = lambda body: client.post(f"/api/cases/{cid}/actions", json=body).status_code  # noqa: E731
    assert post({"action_code": "FREEZE_ALL_ACCOUNTS"}) == 422
    assert post({"action_code": "HOLD_FOR_REVIEW"}) == 422                                  # needs a target
    assert post({"action_code": "HOLD_FOR_REVIEW", "target_account": "AC-999"}) == 422      # not in the case
    assert post({"action_code": "FILE_INTERNAL_SUSPICION_REPORT"}) == 201                   # case-level action


def _hold_target(detail):
    return next(s for s in detail["suggested_actions"] if s["action_code"] == "HOLD_FOR_REVIEW")["target_account"]


def _transfer(client, source, destination="AC-901", amount=50_000):
    res = client.post("/api/transactions/demo", json={"source_account": source, "destination_account": destination,
                                                      "amount": amount})
    assert res.status_code == 201
    return res.json()


def test_hold_stops_new_transfers_until_an_analyst_resolves_them(client):
    detail = _layered(client)
    cid, acc = detail["case"]["case_id"], _hold_target(detail)
    assert _transfer(client, acc)["control"] is None  # no control yet: the transfer goes through

    client.post(f"/api/cases/{cid}/actions", json={"action_code": "HOLD_FOR_REVIEW", "target_account": acc})
    out, inbound = _transfer(client, acc, amount=75_000), _transfer(client, "AC-902", acc)
    for held in (out, inbound):  # both directions are stopped
        assert held["control"]["status"] == "HELD" and held["control"]["case_id"] == cid
    assert "held for review" in out["message"].lower()

    after = client.get(f"/api/cases/{cid}").json()
    assert [c["action_code"] for c in after["account_controls"][acc]] == ["HOLD_FOR_REVIEW"]
    assert {t["transaction_id"] for t in after["controlled_transfers"]} == {
        out["transaction"]["transaction_id"], inbound["transaction"]["transaction_id"]}
    assert any(e["event_type"] == "TRANSFER_HELD" and e["actor_type"] == "SYSTEM" for e in after["audit_events"])
    dash = client.get("/api/dashboard").json()["mitigation"]
    assert dash["accounts_on_hold"] == 1 and dash["held"]["count"] == 2 and dash["held"]["amount"] == 125_000
    assert client.get(f"/api/accounts/{acc}").json()["controls"][0]["action_code"] == "HOLD_FOR_REVIEW"

    resolve = lambda tx, body: client.post(  # noqa: E731
        f"/api/cases/{cid}/held-transfers/{tx['transaction']['transaction_id']}", json=body)
    assert resolve(out, {"resolution": "REJECT"}).status_code == 422  # a reason is required
    rejected = resolve(out, {"resolution": "REJECT", "note": "Customer did not recognise it"})
    assert rejected.status_code == 200 and rejected.json()["transfer"]["status"] == "REJECTED"
    assert resolve(out, {"resolution": "RELEASE", "note": "Changed my mind"}).status_code == 409
    assert resolve(inbound, {"resolution": "RELEASE", "note": "Confirmed with the sender"}).status_code == 200
    dash = client.get("/api/dashboard").json()["mitigation"]
    assert dash["held"]["count"] == 0 and dash["rejected"]["amount"] == 75_000 and dash["released"]["count"] == 1


def test_lifting_a_hold_lets_transfers_through_again(client):
    detail = _layered(client)
    cid, acc = detail["case"]["case_id"], _hold_target(detail)
    body = {"action_code": "HOLD_FOR_REVIEW", "target_account": acc}
    action_id = client.post(f"/api/cases/{cid}/actions", json=body).json()["action"]["action_id"]
    close = lambda: client.post(f"/api/cases/{cid}/actions/{action_id}/close",  # noqa: E731
                                json={"outcome": "Holder verified by callback"})
    lifted = close()
    assert lifted.status_code == 200 and lifted.json()["action"]["status"] == "LIFTED"
    assert close().status_code == 409
    assert _transfer(client, acc)["control"] is None
    assert client.get(f"/api/cases/{cid}").json()["account_controls"] == {}
    assert client.post(f"/api/cases/{cid}/actions", json=body).status_code == 201  # can be applied again


def test_monitoring_flags_transfers_and_tasks_are_tracked_to_completion(client):
    detail = _layered(client)
    cid, acc = detail["case"]["case_id"], detail["case"]["accounts"][0]
    client.post(f"/api/cases/{cid}/actions", json={"action_code": "ENHANCED_MONITORING", "target_account": acc})
    flagged = _transfer(client, acc)
    assert flagged["control"]["status"] == "FLAGGED" and flagged["control"]["control"] == "ENHANCED_MONITORING"

    task = client.post(f"/api/cases/{cid}/actions", json={"action_code": "KYC_REFRESH", "target_account": acc}).json()
    assert task["action"]["status"] == "OPEN" and task["action"]["queue"] == "KYC operations" and task["action"]["due_at"]
    assert client.get("/api/dashboard").json()["mitigation"]["tasks_open"] == 1
    done = client.post(f"/api/cases/{cid}/actions/{task['action']['action_id']}/close",
                       json={"outcome": "Identity re-verified in branch"}).json()["action"]
    assert done["status"] == "COMPLETED" and done["outcome"] == "Identity re-verified in branch"
    assert client.get("/api/dashboard").json()["mitigation"]["tasks_completed"] == 1
