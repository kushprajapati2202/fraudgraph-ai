"""Assistant chats: routing, follow-ups resolved from the stored session, persistence and deletion.
Gemini is mocked; BigQuery routing is covered in test_cloud.py."""
import json

from backend.services import gemini_service

PLAN = {"target": "TRANSFERS", "min_amount": 100000, "max_amount": 0, "channels": ["IMPS"], "risk_bands": [],
        "case_statuses": [], "signal_codes": [], "account_ids": [], "flagged_only": False, "new_account_days": 0,
        "min_kyc_only": False, "account_side": "ANY", "date_from": "", "date_to": "", "sort": "AMOUNT_DESC",
        "limit": 20, "interpretation": "IMPS transfers over 1 lakh", "unsupported": ""}


def _ask(client, question, session_id=None):
    body = {"question": question} | ({"session_id": session_id} if session_id else {})
    resp = client.post("/api/assistant/ask", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_first_question_starts_a_chat_with_a_rule_lookup(client):
    out = _ask(client, "Show IMPS transfers above 1 lakh")
    session, insight = out["session"], out["message"]["insight"]
    assert session["session_id"].startswith("CHAT-") and session["title"] == "Show IMPS transfers above 1 lakh"
    assert session["messages"] == 1 and insight["kind"] == "ASSISTANT"
    r = insight["response"]["result"]
    assert r["mode"] == "LOOKUP" and r["routed_by"] == "RULES" and r["lookup"]["plan"]["channels"] == ["IMPS"]
    assert r["reply"].startswith("Found") and r["analytics"] is None


def test_help_is_fixed_text(client):
    r = _ask(client, "hello")["message"]["insight"]["response"]["result"]
    assert r["mode"] == "HELP" and r["lookup"] is None and "look up" in r["reply"]


def test_chat_is_kept_and_follow_ups_use_the_stored_turns(client, monkeypatch):
    first = _ask(client, "Show IMPS transfers above 1 lakh")
    sid = first["session"]["session_id"]
    prompts = []

    def fake(system, prompt, schema, attachment=None):
        prompts.append((schema.__name__, prompt))
        if schema.__name__ == "Route":
            return json.dumps({"route": "LOOKUP", "standalone_question": "IMPS transfers above 1 lakh via UPI only"})
        return json.dumps(PLAN | {"channels": ["UPI"]})
    monkeypatch.setattr(gemini_service, "generate_json", fake)
    second = _ask(client, "only UPI", sid)
    assert second["session"]["session_id"] == sid and second["session"]["messages"] == 2
    route_prompt = next(p for name, p in prompts if name == "Route")
    assert "Show IMPS transfers above 1 lakh" in route_prompt  # history came from the stored session
    r = second["message"]["insight"]["response"]["result"]
    assert r["standalone_question"] == "IMPS transfers above 1 lakh via UPI only"

    chat = client.get(f"/api/assistant/sessions/{sid}").json()
    assert [m["question"] for m in chat["messages"]] == ["Show IMPS transfers above 1 lakh", "only UPI"]
    assert chat["messages"][1]["insight"]["response"]["result"]["lookup"]["plan"]["channels"] == ["UPI"]
    listed = client.get("/api/assistant/sessions").json()["items"]
    assert listed[0]["session_id"] == sid and listed[0]["messages"] == 2


def test_analytics_without_bigquery_falls_back_to_lookup(client, monkeypatch):
    def fake(system, prompt, schema, attachment=None):
        if schema.__name__ == "Route":
            return json.dumps({"route": "ANALYTICS", "standalone_question": "IMPS amount by day"})
        return json.dumps(PLAN)
    monkeypatch.setattr(gemini_service, "generate_json", fake)
    sid = _ask(client, "hello")["session"]["session_id"]  # history present, so Gemini is asked to route
    r = _ask(client, "IMPS amount by day", sid)["message"]["insight"]["response"]["result"]
    assert r["mode"] == "LOOKUP" and "not connected" in r["note"]


def test_delete_chat_and_unknown_chat(client):
    sid = _ask(client, "high risk cases")["session"]["session_id"]
    assert client.delete(f"/api/assistant/sessions/{sid}").status_code == 200
    assert client.get(f"/api/assistant/sessions/{sid}").status_code == 404
    assert client.post("/api/assistant/ask", json={"question": "high risk cases", "session_id": sid}).status_code == 404
    assert client.post("/api/assistant/ask", json={"question": "x", "session_id": "nope"}).status_code == 422


def test_first_question_is_not_rewritten(client, monkeypatch):
    from backend.config import settings
    monkeypatch.setattr(settings, "google_cloud_project", "proj")
    monkeypatch.setattr(settings, "bigquery_dataset", "fg")  # analytics on, so Gemini routes even a first question
    monkeypatch.setattr(gemini_service, "generate_json", lambda s, p, schema, attachment=None: json.dumps(
        {"route": "LOOKUP", "standalone_question": "Something Gemini made up"} if schema.__name__ == "Route" else PLAN))
    r = _ask(client, "IMPS above 1 lakh")["message"]["insight"]["response"]["result"]
    assert r["routed_by"] == "GEMINI" and r["standalone_question"] == "IMPS above 1 lakh"


def _case(client):
    case_id = client.get("/api/cases").json()["items"][0]["case_id"]
    return client.get(f"/api/cases/{case_id}").json()


def test_attached_case_is_answered_from_its_evidence(client, monkeypatch):
    d = _case(client)
    real = d["evidence"][0]["evidence_id"]

    def fake(system, prompt, schema, attachment=None):
        if schema.__name__ == "Route":
            return json.dumps({"route": "CASE", "standalone_question": "What happened in this case?"})
        return json.dumps({"answer": f"Money moved fast ({real}, EV-MADE-UP).", "evidence_ids": [real, "EV-MADE-UP"]})
    monkeypatch.setattr(gemini_service, "generate_json", fake)
    out = client.post("/api/assistant/ask", json={"question": "What happened in this case?",
                                                  "case_id": d["case"]["case_id"]}).json()
    r = out["message"]["insight"]["response"]["result"]
    assert r["mode"] == "CASE" and r["case"]["case_id"] == d["case"]["case_id"]
    assert r["case"]["evidence_ids"] == [real] and "EV-MADE-UP" not in r["reply"]
    assert out["message"]["insight"]["request"]["case_id"] == d["case"]["case_id"]


def test_workspace_questions_still_run_with_a_case_attached(client):
    d = _case(client)  # Gemini is not configured here: the rule router decides
    r = client.post("/api/assistant/ask", json={"question": "Show all IMPS transfers above 1 lakh",
                                                 "case_id": d["case"]["case_id"]}).json()
    assert r["message"]["insight"]["response"]["result"]["mode"] == "LOOKUP"


def test_case_question_without_gemini_is_reported_unavailable(client):
    d = _case(client)
    out = client.post("/api/assistant/ask", json={"question": "Why is this flagged?", "case_id": d["case"]["case_id"]})
    assert out.status_code == 200 and out.json()["message"]["insight"]["response"]["status"] == "UNAVAILABLE"


def test_unknown_attached_case_is_404(client):
    assert client.post("/api/assistant/ask", json={"question": "Why?", "case_id": "CASE-NOPE"}).status_code == 404
