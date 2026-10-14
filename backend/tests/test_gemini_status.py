"""Gemini connectivity status, error classification and model fallback (no real network calls)."""
import pytest

from backend.config import settings
from backend.models.schemas import ChatAnswer
from backend.services import gemini_service


class FakeAPIError(Exception):
    def __init__(self, code, status, message):
        super().__init__(message)
        self.code, self.status, self.message = code, status, message


class FakeResponse:
    def __init__(self, text):
        self.text = text


def fake_client_factory(behaviour, calls, models_error=None):
    """behaviour: {model: Exception | str}. Records every model called."""
    class Models:
        def generate_content(self, model, contents, config):
            calls.append(model)
            outcome = behaviour[model]
            if isinstance(outcome, Exception):
                raise outcome
            return FakeResponse(outcome)

        def list(self):
            if models_error:
                raise models_error
            return []

    class Client:
        models = Models()

    return lambda timeout_seconds=None: Client()


@pytest.fixture()
def configured(monkeypatch):
    monkeypatch.setattr(settings, "gemini_api_key", "AIzaFAKEKEY_for_tests_0123456789")
    monkeypatch.setattr(settings, "gemini_model", "model-a")
    monkeypatch.setattr(settings, "gemini_fallback_models", "model-b,model-c")
    monkeypatch.setattr(gemini_service, "_preferred_model", None)
    monkeypatch.setattr(gemini_service, "_status_cache", {"at": 0.0, "fingerprint": None, "result": None})


@pytest.mark.parametrize("code,status,message,expected", [
    (400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", "INVALID_KEY"),
    (403, "PERMISSION_DENIED", "denied", "PERMISSION_DENIED"),
    (404, "NOT_FOUND", "This model is no longer available to new users.", "MODEL_NOT_FOUND"),
    (429, "RESOURCE_EXHAUSTED", "quota", "QUOTA_EXCEEDED"),
    (503, "UNAVAILABLE", "This model is currently experiencing high demand.", "OVERLOADED"),
    (504, "DEADLINE_EXCEEDED", "Deadline expired before operation could complete.", "TIMEOUT"),
])
def test_classify_error(code, status, message, expected):
    assert gemini_service.classify_error(FakeAPIError(code, status, message))[0] == expected


def test_error_detail_redacts_key(configured):
    exc = FakeAPIError(400, "INVALID_ARGUMENT", f"bad key {settings.gemini_api_key} given")
    assert settings.gemini_api_key not in gemini_service.classify_error(exc)[1]


def test_status_not_configured(client):
    body = client.get("/api/ai/status").json()
    assert body["state"] == "NOT_CONFIGURED" and body["connected"] is False


def test_status_falls_back_to_working_model(configured, monkeypatch):
    calls = []
    behaviour = {"model-a": FakeAPIError(404, "NOT_FOUND", "retired"),
                 "model-b": FakeAPIError(503, "UNAVAILABLE", "high demand"), "model-c": "OK"}
    monkeypatch.setattr(gemini_service, "_client", fake_client_factory(behaviour, calls))
    status = gemini_service.check_connection(force=True)
    assert calls == ["model-a", "model-b", "model-c"]
    assert status["state"] == "CONNECTED" and status["active_model"] == "model-c" and status["key_valid"] is True
    assert settings.gemini_api_key not in str(status)
    # The working model is tried first afterwards, and generate_json reports it.
    calls.clear()
    assert gemini_service.generate_json("sys", "prompt", ChatAnswer) == "OK"
    assert calls == ["model-c"]


def test_status_degraded_when_key_valid_but_models_busy(configured, monkeypatch):
    busy = FakeAPIError(503, "UNAVAILABLE", "high demand")
    monkeypatch.setattr(gemini_service, "_client",
                        fake_client_factory({"model-a": busy, "model-b": busy, "model-c": busy}, []))
    status = gemini_service.check_connection(force=True)
    assert status["state"] == "DEGRADED" and status["key_valid"] is True and status["connected"] is False


def test_status_invalid_key_stops_immediately(configured, monkeypatch):
    calls = []
    bad = FakeAPIError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.")
    monkeypatch.setattr(gemini_service, "_client",
                        fake_client_factory({"model-a": bad, "model-b": "OK", "model-c": "OK"}, calls))
    status = gemini_service.check_connection(force=True)
    assert calls == ["model-a"]
    assert status["state"] == "INVALID_KEY" and status["key_valid"] is False


def test_generate_json_raises_last_error_when_all_models_fail(configured, monkeypatch):
    slow = FakeAPIError(504, "DEADLINE_EXCEEDED", "Deadline expired")
    monkeypatch.setattr(gemini_service, "_client",
                        fake_client_factory({"model-a": slow, "model-b": slow, "model-c": slow}, []))
    with pytest.raises(gemini_service.GeminiUnavailable) as err:
        gemini_service.generate_json("sys", "prompt", ChatAnswer)
    assert err.value.reason == "TIMEOUT" and "model-c" in err.value.detail
