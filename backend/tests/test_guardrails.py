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
