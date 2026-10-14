"""Similar-case lookup: embeddings path (mocked), caching, and the deterministic fallback."""
from backend.services import case_archive, gemini_service, similarity


def _case_id(client, scenario):
    scen = client.get("/api/demo/scenarios").json()["scenarios"]
    return next(s for s in scen if s["scenario_id"] == scenario)["case_ids"][0]


def test_archive_entries_are_well_formed():
    from backend.services.mitigation import ACTION_CATALOG
    from backend.services.risk_engine import WEIGHTS

    ids = [e["archive_id"] for e in case_archive.ARCHIVE]
    assert len(ids) == len(set(ids)) >= 10
    for e in case_archive.ARCHIVE:
        assert e["outcome"] in case_archive.OUTCOME_LABELS and e["resolution"] and e["pattern"]
        assert set(e["signal_codes"]) <= set(WEIGHTS) and set(e["actions_taken"]) <= set(ACTION_CATALOG)
        assert e["outcome"].lower().replace("_", " ") not in case_archive.fingerprint(e).lower()  # outcome not embedded


def test_fallback_uses_signal_overlap_when_embeddings_unavailable(client):
    body = client.get(f"/api/cases/{_case_id(client, 'fan-in-out-01')}/similar").json()
    assert body["method"] == "SIGNAL_OVERLAP" and body["fallback_reason"] == "NOT_CONFIGURED"
    assert len(body["matches"]) == similarity.TOP_K
    top = body["matches"][0]
    assert "FAN_IN_RAPID_OUT" in {s["code"] for s in top["shared_signals"]}   # the fan-in precedents rank first
    assert 0 <= top["similarity"] <= 1 and top["resolution"] and top["outcome_label"]
    assert sum(body["outcome_summary"].values()) == similarity.TOP_K


def test_embeddings_rank_by_cosine_and_are_cached(client, monkeypatch):
    calls = []

    def fake_embed(texts):
        calls.append(len(texts))
        # 2-d vectors: texts mentioning "fan-in"/"different senders" point one way, everything else the other.
        return [[1.0, 0.1] if ("fan-in" in t or "different senders" in t.lower()) else [0.1, 1.0] for t in texts]

    monkeypatch.setattr(gemini_service, "embed_texts", fake_embed)
    case_id = _case_id(client, "fan-in-out-01")
    body = client.get(f"/api/cases/{case_id}/similar").json()
    assert body["method"] == "GEMINI_EMBEDDINGS" and body["model"]
    assert "different senders" in body["case_description"]
    assert "ARC-2025-0203" in {m["archive_id"] for m in body["matches"][:2]}
    assert body["matches"][0]["similarity"] > 0.99
    assert calls == [len(case_archive.ARCHIVE) + 1]
    client.get(f"/api/cases/{case_id}/similar")                 # second call: everything served from the cache
    assert calls == [len(case_archive.ARCHIVE) + 1]
    client.get(f"/api/cases/{_case_id(client, 'layered-transfer-01')}/similar")
    assert calls[-1] == 1                                        # only the new case is embedded


def test_case_description_contains_no_names_or_account_ids(client, monkeypatch):
    monkeypatch.setattr(gemini_service, "embed_texts", lambda texts: [[1.0, 0.0] for _ in texts])
    case_id = _case_id(client, "layered-transfer-01")
    detail = client.get(f"/api/cases/{case_id}").json()
    text = client.get(f"/api/cases/{case_id}/similar").json()["case_description"]
    assert "AC-" not in text and "TX-" not in text
    for acc in detail["accounts"].values():
        assert acc["holder_name"] not in text
    assert "fan-out" in text and "opened within the previous thirty days" in text
