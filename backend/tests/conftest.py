import pytest
from fastapi.testclient import TestClient

from backend.config import settings
from backend.services import synthetic_data


@pytest.fixture(scope="session")
def data_dir(tmp_path_factory):
    path = tmp_path_factory.mktemp("data")
    synthetic_data.write_csvs(path)
    return path


@pytest.fixture()
def client(tmp_path, data_dir, monkeypatch):
    monkeypatch.setattr(settings, "db_path", str(tmp_path / "test.db"))
    monkeypatch.setattr(settings, "data_dir", str(data_dir))
    monkeypatch.setattr(settings, "gemini_api_key", None)
    # A project in .env would switch Gemini to Vertex AI and turn on the cloud integrations; tests stay offline.
    monkeypatch.setattr(settings, "google_cloud_project", None)
    monkeypatch.setattr(settings, "demo_token", None)
    from backend.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture()
def generated():
    return synthetic_data.generate()
