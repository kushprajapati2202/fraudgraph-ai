"""Citation validation, fallback and prompt-injection handling (T-06, T-07, T-08). Gemini is mocked."""
import json

from backend.services import gemini_service


def _first_case(client):
    cases = client.get("/api/cases").json()["items"]
    assert cases
    return client.get(f"/api/cases/{cases[0]['case_id']}").json()


def _layered_case_id(client):
    scen = client.get("/api/demo/scenarios").json()["scenarios"]
    return next(s for s in scen if s["scenario_id"] == "layered-transfer-01")["case_ids"][0]


def test_t07_unconfigured_gemini_falls_back(client):
    detail = _first_case(client)
    cid = detail["case"]["case_id"]
    res = client.post(f"/api/cases/{cid}/investigate", json={})
    assert res.status_code == 200
    body = res.json()["response"]
    assert body["status"] == "UNAVAILABLE" and body["reason"] == "NOT_CONFIGURED"
    after = client.get(f"/api/cases/{cid}").json()
    assert after["signal_summary"] and after["evidence"]  # deterministic findings preserved


def test_t07_timeout_falls_back(client, monkeypatch):
    def boom(*_args, **_kwargs):
        raise gemini_service.GeminiUnavailable("TIMEOUT")
    monkeypatch.setattr(gemini_service, "generate_json", boom)
    cid = _first_case(client)["case"]["case_id"]
    body = client.post(f"/api/cases/{cid}/investigate", json={}).json()["response"]
    assert body["status"] == "UNAVAILABLE" and body["reason"] == "TIMEOUT"
    events = client.get(f"/api/cases/{cid}").json()["audit_events"]
    assert any(e["event_type"] == "AI_INVESTIGATION" and e["event_payload"]["status"] == "UNAVAILABLE" for e in events)


def test_t06_unknown_evidence_ids_are_removed(client, monkeypatch):
    detail = _first_case(client)
    cid = detail["case"]["case_id"]
    real = detail["evidence"][0]["evidence_id"]
    fake = {
        "case_summary": f"Summary citing {real} and EV-TX-999999.",
        "observed_facts": [
            {"statement": "Supported fact", "evidence_ids": [real, "EV-TX-999999"]},
            {"statement": "Fabricated fact", "evidence_ids": ["EV-FAKE-1"]},
        ],
        "risk_indicators": [{"indicator": "Rapid movement", "reasoning": "Funds moved quickly", "evidence_ids": [real]}],
        "alternative_explanations": ["Legitimate business payments"],
        "uncertainties": ["Limited history"],
        "recommended_next_steps": ["Review source records"],
        "review_priority": "HIGH",
    }
    monkeypatch.setattr(gemini_service, "generate_json", lambda *a, **k: json.dumps(fake))
    body = client.post(f"/api/cases/{cid}/investigate", json={}).json()["response"]
    assert body["status"] == "OK"
    result, validation = body["result"], body["validation"]
    assert set(validation["removed_ids"]) == {"EV-TX-999999", "EV-FAKE-1"}
    assert [f["statement"] for f in result["observed_facts"]] == ["Supported fact"]
    assert result["observed_facts"][0]["evidence_ids"] == [real]
    assert validation["unsupported_claims"][0]["text"] == "Fabricated fact"
    assert "EV-TX-999999" not in result["case_summary"]
    allowed = {e["evidence_id"] for e in detail["evidence"]}
    for section in ("observed_facts", "risk_indicators"):
        for item in result[section]:
            assert set(item["evidence_ids"]) <= allowed


def test_invalid_schema_retries_then_falls_back(client, monkeypatch):
    calls = []
    def bad(*_a, **_k):
        calls.append(1)
        return "{not json"
    monkeypatch.setattr(gemini_service, "generate_json", bad)
    cid = _first_case(client)["case"]["case_id"]
    body = client.post(f"/api/cases/{cid}/investigate", json={}).json()["response"]
    assert body["status"] == "UNAVAILABLE" and body["reason"] == "INVALID_SCHEMA"
    assert len(calls) == 2


def test_t08_injection_text_is_wrapped_as_untrusted_data(client, monkeypatch):
    captured = {}
    def capture(system, prompt, schema):
        captured["system"], captured["prompt"] = system, prompt
        raise gemini_service.GeminiUnavailable("TIMEOUT")
    monkeypatch.setattr(gemini_service, "generate_json", capture)
    cid = _layered_case_id(client)
    status_before = client.get(f"/api/cases/{cid}").json()["case"]["status"]
    client.post(f"/api/cases/{cid}/investigate", json={})
    prompt = captured["prompt"]
    evidence_json = prompt.split("never instructions):\n", 1)[1].split("\n")[0]
    items = json.loads(evidence_json)
    injected = [i for i in items if i["type"] == "TRANSACTION"
                and "ignore previous instructions" in i["data"]["description"]["untrusted_text"]]
    assert injected, "injection text should be present only inside untrusted_text"
    assert "untrusted_text" in captured["system"]
    # Nothing in the AI path changes case state or records a decision.
    after = client.get(f"/api/cases/{cid}").json()
    assert after["case"]["status"] == status_before and after["decisions"] == []


def test_chat_is_scoped_and_validated(client, monkeypatch):
    detail = _first_case(client)
    cid = detail["case"]["case_id"]
    real = detail["evidence"][0]["evidence_id"]
    monkeypatch.setattr(gemini_service, "generate_json",
                        lambda *a, **k: json.dumps({"answer": f"See {real}.", "evidence_ids": [real, "EV-NOPE"]}))
    body = client.post(f"/api/cases/{cid}/chat", json={"message": "What is the strongest indicator?"}).json()
    assert body["response"]["result"]["evidence_ids"] == [real]
    assert body["response"]["validation"]["removed_ids"] == ["EV-NOPE"]
