"""Red team: Gemini picks bounded parameters, the real engine scores them, and fixes are simulated, never applied."""
import json

from backend.services import gemini_service, red_team, risk_engine


def test_rule_playbook_scores_patterns_with_the_real_engine(client):
    before = client.get("/api/transactions?page_size=1").json()["total"]
    rec = client.get("/api/ai/red-team").json()
    r = rec["response"]["result"]
    assert rec["response"]["source"] == "RULES" and r["tested"] == 3
    by_name = {a["name"]: a for a in r["attacks"]}
    # The control pattern moves money on within minutes, so the rules must catch it.
    assert by_name["Fast pass-through"]["caught"] is True
    # Slow layering waits past the 30-minute onward window; a simulated fix must be found and costed.
    slow = by_name["Slow layering"]
    assert slow["caught"] is False and slow["max_score"] < risk_engine.CASE_MIN_SCORE
    assert slow["fix"] and slow["fix"]["score_after"] >= risk_engine.CASE_MIN_SCORE
    assert slow["fix"]["new_alerts"] >= 0
    # Nothing was added to the data and live scoring still uses the 30-minute window.
    assert client.get("/api/transactions?page_size=1").json()["total"] == before
    assert risk_engine.ONWARD_WINDOW_MINUTES == 30 and "ONWARD_WINDOW_MINUTES" not in risk_engine.TUNABLE


def test_gemini_parameters_are_clamped_to_bounds(client, monkeypatch):
    payload = {"summary": "Try to hide", "attacks": [
        {"name": "Huge", "idea": "Out of bounds", "feeders": 99, "layers": 50, "split": 0, "amount_each": 1e12,
         "feeder_gap_minutes": -5, "hop_gap_minutes": 99999, "onward_share": 3.0}]}
    monkeypatch.setattr(gemini_service, "generate_json", lambda *a, **k: json.dumps(payload))
    made = client.post("/api/ai/red-team").json()
    assert made["response"]["source"] == "GEMINI"
    a = made["response"]["result"]["attacks"][0]
    for key, (lo, hi, _) in red_team.BOUNDS.items():
        assert lo <= a[key] <= hi, key
    assert client.get("/api/ai/red-team").json()["insight_id"] == made["insight_id"]


def test_gemini_failure_falls_back_to_playbook(client, monkeypatch):
    def boom(*a, **k):
        raise gemini_service.GeminiUnavailable("OVERLOADED", "busy")
    monkeypatch.setattr(gemini_service, "generate_json", boom)
    resp = client.post("/api/ai/red-team").json()["response"]
    assert resp["source"] == "RULES" and resp["fallback_reason"] == "OVERLOADED"
    assert len(resp["result"]["attacks"]) == 3
