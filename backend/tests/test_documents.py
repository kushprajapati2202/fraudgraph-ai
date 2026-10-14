"""Supporting-document verification: upload validation, deterministic comparison, and the API flow (Gemini mocked)."""
import base64
import json

import pytest

from backend.services import document_check, gemini_service

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
TX = {"amount": 2500000.0, "currency": "INR", "timestamp": "2026-09-15T12:00:21"}


def extraction(**over):
    base = {"document_type": "Receipt", "issuer_name": "Sunridge Developers Pvt Ltd", "payer_name": "Priya Bansal",
            "payee_name": "Sunridge Developers Pvt Ltd", "amount": 2500000, "currency": "INR",
            "document_date": "2026-09-15", "reference_numbers": ["2291"], "purpose": "Flat booking",
            "legibility": "CLEAR", "observations": [], "tamper_indicators": []}
    return {**base, **over}


def results(checks):
    return {c["check"]: c["result"] for c in checks}


def test_decode_rejects_bad_uploads():
    ok = base64.b64encode(PNG).decode()
    assert document_check.decode_upload(ok, "image/png") == PNG
    for data, mime in [(ok, "image/jpeg"), ("not base64!!", "image/png"), (ok, "text/html"),
                       (base64.b64encode(b"<script>alert(1)</script>").decode(), "application/pdf")]:
        with pytest.raises(document_check.DocumentError):
            document_check.decode_upload(data, mime)


def test_matching_document_supports():
    ex = extraction()
    checks = document_check.compare(ex, TX, "Priya Bansal", "Sunridge Developers Pvt Ltd")
    assert results(checks) == {"Amount": "MATCH", "Currency": "MATCH", "Date": "MATCH", "Payer": "MATCH", "Payee": "MATCH"}
    assert document_check.verdict(ex, checks) == "SUPPORTS"


def test_wrong_amount_or_payee_does_not_support():
    ex = extraction(amount=500000)
    checks = document_check.compare(ex, TX, "Priya Bansal", "Sunridge Developers Pvt Ltd")
    assert results(checks)["Amount"] == "MISMATCH" and document_check.verdict(ex, checks) == "DOES_NOT_SUPPORT"
    ex = extraction(payee_name="Orbit Motors LLP", issuer_name="Orbit Motors LLP")
    checks = document_check.compare(ex, TX, "Priya Bansal", "Sunridge Developers Pvt Ltd")
    assert results(checks)["Payee"] == "MISMATCH" and document_check.verdict(ex, checks) == "DOES_NOT_SUPPORT"


def test_missing_fields_and_tamper_signs_are_only_partial():
    ex = extraction(payer_name="", document_date="")
    checks = document_check.compare(ex, TX, "Priya Bansal", "Sunridge Developers Pvt Ltd")
    assert results(checks)["Payer"] == "NOT_FOUND" and results(checks)["Date"] == "NOT_FOUND"
    assert document_check.verdict(ex, checks) == "PARTIALLY_SUPPORTS"
    ex = extraction(tamper_indicators=["Total does not equal the sum of line items"])
    assert document_check.verdict(ex, document_check.compare(ex, TX, "Priya Bansal", "Sunridge Developers Pvt Ltd")) == "PARTIALLY_SUPPORTS"
    ex = extraction(legibility="UNREADABLE")
    assert document_check.verdict(ex, []) == "UNREADABLE"


def _legit_case(client):
    scen = client.get("/api/demo/scenarios").json()["scenarios"]
    s = next(x for x in scen if x["scenario_id"] == "legit-high-value-01")
    return s["case_ids"][0], s["transaction_ids"][0]


def test_document_endpoint_extracts_compares_and_audits(client, monkeypatch):
    case_id, tx_id = _legit_case(client)
    tx = client.get(f"/api/transactions/{tx_id}").json()
    payer = tx["accounts"][tx["transaction"]["source_account"]]["holder_name"]
    payee = tx["accounts"][tx["transaction"]["destination_account"]]["holder_name"]
    seen = {}

    def fake(system, prompt, schema, attachment=None):
        seen["attachment"], seen["system"] = attachment, system
        return json.dumps(extraction(payer_name=payer, payee_name=payee, issuer_name=payee,
                                     amount=tx["transaction"]["amount"], document_date=tx["transaction"]["timestamp"][:10]))

    monkeypatch.setattr(gemini_service, "generate_json", fake)
    body = {"filename": "receipt<script>.png", "mime_type": "image/png", "data_base64": base64.b64encode(PNG).decode(),
            "transaction_id": tx_id}
    res = client.post(f"/api/cases/{case_id}/documents", json=body)
    assert res.status_code == 201
    out = res.json()
    assert out["verdict"] == "SUPPORTS" and out["response"]["status"] == "OK"
    assert "<" not in out["filename"] and len(out["sha256"]) == 64
    assert seen["attachment"] == (PNG, "image/png") and "untrusted" in seen["system"]
    detail = client.get(f"/api/cases/{case_id}").json()
    assert detail["documents"][0]["verdict"] == "SUPPORTS"
    event = [e for e in detail["audit_events"] if e["event_type"] == "AI_DOCUMENT_CHECK"][-1]
    assert event["actor_type"] == "AI" and event["event_payload"]["file_stored"] is False
    assert detail["case"]["status"] == "OPEN" and detail["decisions"] == []  # a document never decides the case


def test_document_endpoint_validation_and_fallback(client):
    case_id, tx_id = _legit_case(client)
    good = base64.b64encode(PNG).decode()
    post = lambda **b: client.post(f"/api/cases/{case_id}/documents", json={  # noqa: E731
        "filename": "a.png", "mime_type": "image/png", "data_base64": good, "transaction_id": tx_id, **b})
    assert post(mime_type="text/html").status_code == 422
    assert post(data_base64=base64.b64encode(b"not a png at all").decode()).status_code == 422
    assert post(transaction_id="TX-1001").status_code == 422          # not in this case
    res = post()                                                       # Gemini not configured in tests
    assert res.status_code == 201 and res.json()["response"]["status"] == "UNAVAILABLE" and res.json()["verdict"] is None
