from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent

APP_VERSION = "0.1.0"
DATASET_VERSION = "ds-v2"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    gemini_api_key: str | None = None
    # "api_key" = Gemini Developer API (AI Studio key); "vertex" = Vertex AI on Google Cloud using the service
    # account (no key to manage; recommended on Cloud Run); "auto" = vertex when a project is set and no key is.
    gemini_backend: str = "auto"
    google_cloud_project: str | None = None
    google_cloud_location: str = "global"
    gemini_model: str = "gemini-3.8-flash"
    # Tried in order when the primary model is retired, overloaded, rate-limited or times out.
    gemini_fallback_models: str = "gemini-flash-latest,gemini-3.1-flash-lite,gemini-flash-lite-latest"
    gemini_timeout_seconds: float = 30.0
    gemini_embedding_model: str = "gemini-embedding-001"  # used for "similar cases"
    # Google Cloud integrations. Each one is off until its setting is present, so local runs and tests need none.
    gcs_state_bucket: str | None = None  # Cloud Storage bucket holding the SQLite snapshot (state survives restarts)
    bigquery_dataset: str | None = None  # BigQuery dataset for the analytics mirror, e.g. "fraudgraph"
    bigquery_location: str = "US"
    pubsub_topic: str | None = None  # topic id for incoming transfers, e.g. "fraudgraph-transfers"
    pubsub_push_token: str | None = None  # shared secret on the push subscription URL (?token=...)
    docai_processor: str | None = None  # projects/<p>/locations/us/processors/<id> (Invoice or Expense parser)
    vertex_search_serving_config: str | None = None  # .../dataStores/<id>/servingConfigs/default_search
    demo_token: str | None = None
    db_path: str | None = None
    data_dir: str = str(ROOT / "data")
    frontend_dist: str = str(ROOT / "frontend" / "dist")

    @property
    def resolved_db_path(self) -> str:
        return self.db_path or str(ROOT / "fraudgraph.db")

    @property
    def has_api_key(self) -> bool:
        return bool(self.gemini_api_key and self.gemini_api_key.strip())

    @property
    def use_vertex(self) -> bool:
        backend = (self.gemini_backend or "auto").strip().lower()
        if backend == "vertex":
            return bool(self.google_cloud_project)
        if backend == "api_key":
            return False
        return bool(self.google_cloud_project) and not self.has_api_key

    @property
    def gemini_backend_name(self) -> str:
        return "Vertex AI" if self.use_vertex else "Gemini API"

    @property
    def gemini_configured(self) -> bool:
        return self.use_vertex or self.has_api_key

    @property
    def gemini_model_chain(self) -> list[str]:
        chain: list[str] = []
        for name in [self.gemini_model, *self.gemini_fallback_models.split(",")]:
            name = name.strip()
            if name and name not in chain:
                chain.append(name)
        return chain


settings = Settings()
