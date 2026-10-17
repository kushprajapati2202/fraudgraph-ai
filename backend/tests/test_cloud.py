import base64
import json

import pytest

from backend.config import settings
from backend.services import bigquery_ask, bigquery_sync, docai


@pytest.fixture()
def bq(monkeypatch):
    monkeypatch.setattr(settings, "google_cloud_project", "proj")
    monkeypatch.setattr(settings, "bigquery_dataset", "fg")


# ---- SQL guard ----

@pytest.mark.parametrize("sql", [
    "SELECT channel, COUNT(*) n FROM `proj.fg.transfers` GROUP BY channel",
    "WITH x AS (SELECT * FROM `proj.fg.cases`) SELECT * FROM x LIMIT 5",
    "SELECT * FROM `proj.fg.transfers` WHERE channel = 'UPI; DROP' LIMIT 5;",
])
def test_static_check_accepts_read_only(bq, sql):
    assert bigquery_ask.static_check(sql)


@pytest.mark.parametrize("sql, reason", [
    ("DELETE FROM `proj.fg.transfers` WHERE TRUE", "SELECT"),
    ("SELECT 1 FROM `proj.fg.transfers`; DROP TABLE `proj.fg.transfers`", "one statement"),
    ("SELECT * FROM `proj.other.secrets`", "not in the analytics dataset"),
    ("SELECT * FROM transfers", "fully qualified"),
    ("SELECT * FROM `proj.fg.transfers` -- hi", "Comments"),
    ("SELECT * FROM `proj.fg.INFORMATION_SCHEMA.TABLES`", "INFORMATION_SCHEMA"),
    ("WITH a AS (SELECT 1) INSERT INTO `proj.fg.cases` SELECT * FROM a", "INSERT"),
])
def test_static_check_rejects(bq, sql, reason):
    with pytest.raises(bigquery_ask.SqlRejected, match=reason):
        bigquery_ask.static_check(sql)


def test_ask_never_returns_the_query(bq, monkeypatch):
    sql = "SELECT channel, COUNT(*) AS n FROM `proj.fg.transfers` GROUP BY channel"
    replies = iter([
        (bigquery_ask.SqlPlan(sql="DELETE FROM `proj.fg.transfers`", interpretation="x", chart="TABLE", x_column="", y_column=""), None, None),
        (bigquery_ask.SqlPlan(sql=sql, interpretation="Transfers per channel", chart="BAR", x_column="channel", y_column="n"), None, None),
        (bigquery_ask.SqlAnswer(answer="UPI has 42 transfers."), None, None),
    ])
    monkeypatch.setattr(bigquery_ask.ai_common, "ask", lambda *a, **k: next(replies))
    monkeypatch.setattr(bigquery_ask, "_dry_run", lambda q: 1024)
    monkeypatch.setattr(bigquery_ask, "_execute", lambda q: (["channel", "n"], [{"channel": "UPI", "n": 42}], 2048))
    response = bigquery_ask.ask("transfers per channel")
    result = response["result"]
    assert "sql" not in result and result["repairs"] == 1
    dumped = json.dumps(response)
    assert "SELECT" not in dumped and "DELETE" not in dumped


def test_grounded_answer_checks_numbers():
    rows = [{"channel": "UPI", "total": 1234567.0, "n": 42}]
    assert bigquery_ask.grounded_answer("UPI moved 1,234,567 across 42 transfers.", rows)
    assert bigquery_ask.grounded_answer("UPI moved ₹12.35 L.", rows)
    assert not bigquery_ask.grounded_answer("UPI moved 9,999,999.", rows)


# ---- Document AI cross-check ----

def test_docai_compare_and_verdict():
    gemini = {"amount": 48500.0, "document_date": "2026-09-12", "payee_name": "Sea Breeze Stays Pvt Ltd",
              "payer_name": "Priya Bansal"}
    same = {"amount": 48500.0, "date": "2026-09-12", "payee": "Sea Breeze Stays", "payer": "Priya Bansal"}
    rows = docai.compare(gemini, same)
    assert {r["agreement"] for r in rows} == {"AGREE"}
    assert docai.adjust_verdict("SUPPORTS", rows) == ("SUPPORTS", None)

    differ = {**same, "amount": 84500.0}
    rows = docai.compare(gemini, differ)
    assert next(r for r in rows if r["field"] == "Amount")["agreement"] == "DISAGREE"
    verdict, note = docai.adjust_verdict("SUPPORTS", rows)
    assert verdict == "PARTIALLY_SUPPORTS" and "amount" in note

    rows = docai.compare(gemini, {"amount": 0, "date": "", "payee": "", "payer": ""})
    assert {r["agreement"] for r in rows} == {"ONLY_GEMINI"}


# ---- BigQuery mirror shape ----

def test_snapshot_rows_match_schema(client):
    from backend.db import connect

    with connect() as conn:
        rows = bigquery_sync.snapshot_rows(conn)
    assert set(rows) == set(bigquery_sync.TABLES)
    for table, data in rows.items():
        cols = {c[0] for c in bigquery_sync.TABLES[table]}
        if table in ("decisions", "mitigation_actions"):
            continue  # empty on a fresh baseline
        assert set(data[0]) == cols, table
    tx = rows["transfers"][0]
    assert tx["ts"].endswith("+00:00") and isinstance(tx["signal_codes"], list)
    json.dumps(rows)  # load_table_from_json needs plain JSON


# ---- Cloud endpoints without configuration ----

def test_cloud_status_and_not_configured(client):
    status = client.get("/api/cloud/status").json()
    keys = {s["key"]: s for s in status["services"]}
    assert not keys["bigquery"]["enabled"] and not keys["pubsub"]["enabled"]
    assert client.post("/api/cloud/bigquery/ask", json={"question": "top channels"}).json()["error"]["code"] == "NOT_CONFIGURED"
    assert client.post("/api/cloud/stream/publish", json={
        "source_account": "AC-101", "destination_account": "AC-102", "amount": 100}).status_code == 409
    case_id = client.get("/api/cases").json()["items"][0]["case_id"]
    ml = client.get(f"/api/cases/{case_id}/ml").json()
    assert ml["enabled"] is False and ml["transfers"] == []


def _envelope(payload: dict, message_id: str = "m-1") -> dict:
    return {"message": {"messageId": message_id, "publishTime": "2026-10-17T10:00:00Z",
                        "data": base64.b64encode(json.dumps(payload).encode()).decode()}, "subscription": "s"}


def test_pubsub_push_is_idempotent_and_enforces_token(client, monkeypatch):
    monkeypatch.setattr(settings, "pubsub_push_token", "secret-token")
    payload = {"transaction_id": "TX-D100001", "source_account": "AC-101", "destination_account": "AC-102",
               "amount": 2500, "channel": "UPI"}
    assert client.post("/api/cloud/stream/push?token=wrong", json=_envelope(payload)).status_code == 403

    first = client.post("/api/cloud/stream/push?token=secret-token", json=_envelope(payload)).json()
    assert first["status"] == "PROCESSED" and first["transaction_id"] == "TX-D100001"
    again = client.post("/api/cloud/stream/push?token=secret-token", json=_envelope(payload)).json()
    assert again["status"] == "DUPLICATE"
    redelivered = client.post("/api/cloud/stream/push?token=secret-token", json=_envelope(payload, "m-2")).json()
    assert redelivered["status"] == "DUPLICATE"  # same transfer under a new message ID

    bad = client.post("/api/cloud/stream/push?token=secret-token",
                      json=_envelope({"source_account": "nope", "amount": -1}, "m-3")).json()
    assert bad["status"] == "REJECTED"

    events = client.get("/api/cloud/stream/events").json()["events"]
    assert [e["status"] for e in events if e["message_id"] == "m-1"] == ["PROCESSED"]
    assert client.get("/api/transactions/TX-D100001").json()["assessment"]["score"] is not None
