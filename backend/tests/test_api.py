"""API smoke and workflow tests (T-05, T-09, FR-001..FR-015)."""
from backend.config import settings


def test_health_has_no_secrets(client, monkeypatch):
    monkeypatch.setattr(settings, "gemini_api_key", "super-secret-key")
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok" and body["data_loaded"] and body["gemini_configured"]
    assert "super-secret-key" not in res.text


def test_reset_is_repeatable(client):
    first = client.post("/api/demo/reset").json()
    second = client.post("/api/demo/reset").json()
    assert first["transactions"] == second["transactions"] and first["accounts"] == second["accounts"]
    assert [s["scenario_id"] for s in first["scenarios"]] == [s["scenario_id"] for s in second["scenarios"]]
    run1 = client.post("/api/analysis/run", json={"time_window_minutes": 60}).json()
    client.post("/api/demo/reset")
    run2 = client.post("/api/analysis/run", json={"time_window_minutes": 60}).json()
    assert run1["active_cases"] == run2["active_cases"]
    ids1 = [c["case_id"] for c in client.get("/api/cases").json()["items"]]
    assert ids1  # cases exist after analysis


def test_dashboard_counts_match(client):
    dash = client.get("/api/dashboard").json()
    total = client.get("/api/transactions", params={"page_size": 1}).json()["total"]
    assert dash["totals"]["transactions"] == total
    assert sum(dash["cases_by_band"].values()) == dash["totals"]["cases"]


def test_transaction_filters(client):
    res = client.get("/api/transactions", params={"min_amount": 100000, "sort": "amount", "order": "desc"}).json()
    assert res["items"] and all(t["amount"] >= 100000 for t in res["items"])
    amounts = [t["amount"] for t in res["items"]]
    assert amounts == sorted(amounts, reverse=True)
    bad = client.get("/api/transactions", params={"sort": "amount; DROP TABLE transactions"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "VALIDATION_ERROR"
    q = client.get("/api/transactions", params={"q": "%"}).json()
    assert q["total"] == 0  # wildcard is escaped, not interpreted


def test_transaction_detail_and_missing(client):
    first = client.get("/api/transactions", params={"page_size": 1}).json()["items"][0]
    detail = client.get(f"/api/transactions/{first['transaction_id']}").json()
    assert detail["transaction"]["transaction_id"] == first["transaction_id"]
    assert detail["assessment"]["rule_version"] == "rules-v1"
    missing = client.get("/api/transactions/TX-0")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "NOT_FOUND"


def test_case_detail_graph_and_evidence_resolve(client):
    case = client.get("/api/cases", params={"risk_band": "HIGH"}).json()["items"][0]
    detail = client.get(f"/api/cases/{case['case_id']}").json()
    tx_ids = set(detail["case"]["transaction_ids"])
    assert detail["evidence"] and detail["signal_summary"]
    graph = client.get("/api/graph", params={"case_id": case["case_id"]}).json()
    for edge in graph["edges"]:  # every edge is a real transaction
        assert client.get(f"/api/transactions/{edge['id']}").status_code == 200
    assert tx_ids <= {e["id"] for e in graph["edges"] if e["in_focus"]}
    for e in detail["evidence"]:
        if e["source_type"] == "TRANSACTION":
            assert e["source_id"] in tx_ids


def test_t09_decision_is_persisted_and_audited(client):
    cid = client.get("/api/cases").json()["items"][0]["case_id"]
    res = client.post(f"/api/cases/{cid}/decision",
                      json={"decision": "DISMISS_ALERT", "rationale": "Verified as routine business payments."})
    assert res.status_code == 201 and res.json()["case_status"] == "DISMISSED"
    detail = client.get(f"/api/cases/{cid}").json()
    assert detail["decisions"][-1]["decision"] == "DISMISS_ALERT"
    assert detail["decisions"][-1]["rationale"] and detail["decisions"][-1]["created_at"]
    event = [e for e in detail["audit_events"] if e["event_type"] == "ANALYST_DECISION"][-1]
    assert event["actor_type"] == "HUMAN"
    # Re-running analysis keeps the human decision and status.
    client.post("/api/analysis/run", json={})
    again = client.get(f"/api/cases/{cid}").json()
    assert again["case"]["status"] == "DISMISSED" and len(again["decisions"]) == 1


def test_decision_validation(client):
    cid = client.get("/api/cases").json()["items"][0]["case_id"]
    assert client.post(f"/api/cases/{cid}/decision", json={"decision": "CLOSE", "rationale": "xxxxxx"}).status_code == 422
    assert client.post(f"/api/cases/{cid}/decision",
                       json={"decision": "DISMISS_ALERT", "rationale": "    "}).status_code == 422


def test_t05_duplicate_synthetic_transaction_rejected(client):
    tx = client.get("/api/transactions", params={"page_size": 1}).json()["items"][0]
    body = {"transaction_id": "TX-D100", "source_account": tx["source_account"], "destination_account": "AC-901",
            "amount": 5000, "channel": "UPI"}
    assert client.post("/api/transactions/demo", json=body).status_code == 201
    dup = client.post("/api/transactions/demo", json=body)
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "DUPLICATE_TRANSACTION"


def test_synthetic_transaction_validation(client):
    base = {"source_account": "AC-101", "destination_account": "AC-101", "amount": 10}
    assert client.post("/api/transactions/demo", json=base).status_code == 422
    assert client.post("/api/transactions/demo", json={**base, "destination_account": "AC-555", "amount": -5}).status_code == 422
    unknown = client.post("/api/transactions/demo", json={"source_account": "AC-1234", "destination_account": "AC-901",
                                                          "amount": 10})
    assert unknown.status_code == 422
    old = client.post("/api/transactions/demo", json={"source_account": "AC-901", "destination_account": "AC-902",
                                                      "amount": 10, "timestamp": "2020-01-01T00:00:00"})
    assert old.status_code == 422


def test_what_if_extends_layered_case(client):
    scen = client.get("/api/demo/scenarios").json()
    suggested = scen["suggested_what_if"]
    layered = next(s for s in scen["scenarios"] if s["scenario_id"] == "layered-transfer-01")
    case_id = layered["case_ids"][0]
    payload = {k: suggested[k] for k in ("source_account", "destination_account", "amount", "timestamp", "channel",
                                         "description")}
    created = client.post("/api/transactions/demo", json=payload)
    assert created.status_code == 201
    new_id = created.json()["transaction"]["transaction_id"]
    assert created.json()["transaction"]["is_synthetic_added"] == 1
    run = client.post("/api/analysis/run", json={"scenario_id": "layered-transfer-01"}).json()
    assert new_id in run["diff"]["new_transactions"]
    assert case_id in run["focus_case_ids"]
    updated = {c["case_id"]: c for c in run["diff"]["updated_cases"]}
    assert new_id in updated[case_id]["added_transaction_ids"]


def test_demo_token_enforced(client, monkeypatch):
    monkeypatch.setattr(settings, "demo_token", "letmein")
    assert client.post("/api/demo/reset").status_code == 401
    assert client.post("/api/demo/reset", headers={"X-Demo-Token": "letmein"}).status_code == 200


def test_unknown_api_route_is_json_404(client):
    res = client.get("/api/nope")
    assert res.status_code == 404 and res.json()["error"]["code"] == "NOT_FOUND"
