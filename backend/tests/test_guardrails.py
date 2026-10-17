"""Guardrail self-test: tampered model output is stopped by the production validators, without calling a model."""


def _case_id(client) -> str:
    scen = client.get("/api/demo/scenarios").json()["scenarios"]
    return next(s for s in scen if s["scenario_id"] == "layered-transfer-01")["case_ids"][0]


def test_guardrail_test_blocks_every_attack_and_keeps_the_control(client):
    r = client.post(f"/api/cases/{_case_id(client)}/guardrail-test")
    assert r.status_code == 200
    body = r.json()
    assert body["model_called"] is False and body["all_passed"] is True
    outcomes = {c["key"]: c["outcome"] for c in body["checks"]}
    assert outcomes == {
        "fabricated_citation": "BLOCKED", "inline_reference": "BLOCKED", "uncited_claim": "BLOCKED",
        "outside_account": "BLOCKED", "off_catalogue": "BLOCKED", "untrusted_text": "CONTAINED", "control": "PASSED",
    }
    assert body["stopped"] == body["attacks"] == 6


def test_guardrail_test_unknown_case_is_404(client):
    assert client.post("/api/cases/CASE-NOPE/guardrail-test").status_code == 404


def test_guardrail_test_is_audited_and_reported_as_last_run(client):
    case_id = _case_id(client)
    r = client.post(f"/api/cases/{case_id}/guardrail-test", json={"actor_label": "Priya Nair"})
    assert r.status_code == 200
    log = client.get("/api/audit", params={"case_id": case_id}).json()
    event = next(e for e in log["items"] if e["event_type"] == "AI_GUARDRAIL_TEST")
    assert event["actor_type"] == "HUMAN"
    assert event["event_payload"]["actor_label"] == "Priya Nair"
    assert event["event_payload"]["stopped"] == event["event_payload"]["attacks"] == 6
    assert event["event_payload"]["failed_checks"] == []
    last = log["last_guardrail_test"]
    assert last["case_id"] == case_id and last["all_passed"] is True and last["actor_label"] == "Priya Nair"
