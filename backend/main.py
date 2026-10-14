import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.api import accounts, analysis, cases, dashboard, demo, graph, health, transactions
from backend.config import APP_VERSION, settings
from backend.db import connect, init_schema
from backend.errors import AppError, error_body
from backend.services import analysis as analysis_service
from backend.services import dataset

class _CloudLoggingFormatter(logging.Formatter):
    """One JSON object per line, in the shape Google Cloud Logging parses (severity, message, logger)."""

    def format(self, record: logging.LogRecord) -> str:
        import json

        entry = {"severity": record.levelname, "message": record.getMessage(), "logger": record.name}
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry)


if os.environ.get("K_SERVICE"):  # set by Cloud Run
    _handler = logging.StreamHandler()
    _handler.setFormatter(_CloudLoggingFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[_handler])
else:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("fraudgraph")

HTTP_CODES = {400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND",
              405: "METHOD_NOT_ALLOWED", 409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE", 429: "RATE_LIMITED"}


def bootstrap() -> None:
    """Create schema; on an empty database load the synthetic baseline and run the first analysis."""
    with connect() as conn:
        init_schema(conn)
        from backend.config import DATASET_VERSION
        from backend.db import get_meta

        # Reload when empty or when the stored dataset comes from an older dataset/schema version.
        if not dataset.is_loaded(conn) or get_meta(conn, "dataset_version") != DATASET_VERSION:
            logger.info("Loading dataset %s and running initial analysis", DATASET_VERSION)
            dataset.reset(conn)
            analysis_service.run(conn)


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    yield


app = FastAPI(title="FraudGraph AI", version=APP_VERSION, lifespan=lifespan,
              description="Synthetic-data prototype for connected transaction investigation.")


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    response.headers["X-Request-ID"] = request_id
    if request.url.path.startswith("/api"):
        logger.info("request_id=%s method=%s path=%s status=%s duration_ms=%.1f",
                    request_id, request.method, request.url.path, response.status_code, elapsed_ms)
    return response


@app.exception_handler(AppError)
async def app_error_handler(_: Request, exc: AppError):
    return JSONResponse(status_code=exc.status_code, content=error_body(exc.code, exc.message, exc.details))


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError):
    details = [{"field": ".".join(str(p) for p in e.get("loc", ()) if p != "body"), "message": e.get("msg")}
               for e in exc.errors()]
    return JSONResponse(status_code=422, content=error_body("VALIDATION_ERROR", "Request validation failed.", details))


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_: Request, exc: StarletteHTTPException):
    code = HTTP_CODES.get(exc.status_code, "HTTP_ERROR")
    message = exc.detail if isinstance(exc.detail, str) else "Request failed."
    return JSONResponse(status_code=exc.status_code, content=error_body(code, message))


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    request_id = getattr(request.state, "request_id", "-")
    logger.error("request_id=%s unhandled error type=%s", request_id, type(exc).__name__, exc_info=exc)
    return JSONResponse(status_code=500, content=error_body(
        "INTERNAL_ERROR", f"An unexpected error occurred (request {request_id}).", []))


for module in (health, dashboard, demo, transactions, accounts, analysis, graph, cases):
    app.include_router(module.router, prefix="/api")


_dist = Path(settings.frontend_dist)


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path == "api" or full_path.startswith("api/"):
        raise AppError(404, "NOT_FOUND", "Unknown API route.")
    index = _dist / "index.html"
    if not index.exists():
        return JSONResponse({"message": "FraudGraph AI API is running. Frontend build not found; see README.",
                             "docs": "/docs"})
    if full_path:
        candidate = (_dist / full_path).resolve()
        if candidate.is_file() and _dist.resolve() in candidate.parents:
            return FileResponse(candidate)
    return FileResponse(index)
