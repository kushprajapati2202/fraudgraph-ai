"""Google Cloud integrations: status, Pub/Sub event stream, BigQuery analytics and ML, policy search.

Each integration is optional. When it is not configured its endpoints answer 409 NOT_CONFIGURED, and the
console hides the matching controls.
"""
import hmac
import logging
import os

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from backend.api.cases import _case_row
from backend.api.deps import require_demo_token
from backend.config import settings
from backend.db import connect
from backend.errors import AppError
from backend.models.schemas import AskRequest, DemoTransactionRequest
from backend.services import (ai_common, bigquery_ask, bigquery_ml, bigquery_sync, docai, policy_search,
                              pubsub_stream, state_sync)
from backend.services import analysis as analysis_service

logger = logging.getLogger("fraudgraph.cloud")
router = APIRouter(tags=["cloud"])


def _need(enabled: bool, name: str) -> None:
    if not enabled:
        raise AppError(409, "NOT_CONFIGURED", f"{name} is not configured on this deployment.")


@router.get("/cloud/status")
def cloud_status() -> dict:
    """Which Google Cloud services this deployment uses, and their last known state. Never returns secrets."""
    on_cloud_run = bool(os.environ.get("K_SERVICE"))
    return {
        "project": settings.google_cloud_project,
        "services": [
            {"key": "cloud_run", "name": "Cloud Run", "enabled": on_cloud_run,
             "detail": f"Service {os.environ.get('K_SERVICE')} revision {os.environ.get('K_REVISION')}" if on_cloud_run else "Running locally"},
            {"key": "gemini", "name": settings.gemini_backend_name if settings.gemini_configured else "Gemini",
             "enabled": settings.gemini_configured, "detail": f"Model chain: {', '.join(settings.gemini_model_chain)}"},
            {"key": "storage", "name": "Cloud Storage", "enabled": state_sync.enabled(),
             "detail": "Workspace state snapshot", "state": state_sync.status},
            {"key": "bigquery", "name": "BigQuery", "enabled": bigquery_sync.enabled(),
             "detail": f"Dataset {settings.bigquery_dataset}" if bigquery_sync.enabled() else None,
             "state": bigquery_sync.status},
            {"key": "bigquery_ml", "name": "BigQuery ML", "enabled": bigquery_ml.enabled(),
             "detail": "Boosted-tree second opinion", "state": {k: bigquery_ml.status[k] for k in ("state", "error", "trained_at")}},
            {"key": "pubsub", "name": "Pub/Sub", "enabled": pubsub_stream.enabled(),
             "detail": f"Topic {settings.pubsub_topic}" if pubsub_stream.enabled() else None},
            {"key": "document_ai", "name": "Document AI", "enabled": docai.enabled(),
             "detail": "Second reader for supporting documents" if docai.enabled() else None},
            {"key": "vertex_search", "name": "Vertex AI Search", "enabled": policy_search.enabled(),
             "detail": "Policy library retrieval" if policy_search.enabled() else None},
        ],
    }


# ---- Pub/Sub event stream ----

@router.post("/cloud/stream/publish", status_code=202, dependencies=[Depends(require_demo_token)])
def stream_publish(body: DemoTransactionRequest) -> dict:
    _need(pubsub_stream.enabled(), "Pub/Sub")
    payload = body.model_dump(mode="json", exclude_none=True)
    payload["transaction_id"] = payload.get("transaction_id") or pubsub_stream.next_transaction_id()
    message_id = pubsub_stream.publish(payload)
    return {"status": "QUEUED", "message_id": message_id, "transaction_id": payload["transaction_id"],
            "topic": settings.pubsub_topic}


@router.post("/cloud/stream/push", include_in_schema=False)
async def stream_push(request: Request, token: str = Query(default="")):
    """Pub/Sub push endpoint. Always acknowledges (2xx) a message it has handled, including rejected ones, so a
    malformed message is not redelivered forever; only an unexpected server error asks for a retry."""
    expected = settings.pubsub_push_token or ""
    if not expected or not hmac.compare_digest(token, expected):
        raise AppError(403, "FORBIDDEN", "Invalid push token.")
    try:
        message_id, payload, published = pubsub_stream.decode_push(await request.json())
    except ValueError as exc:
        logger.warning("Rejected Pub/Sub message: %s", exc)
        return JSONResponse({"status": "REJECTED", "detail": str(exc)})
    if pubsub_stream.already_processed(message_id):
        return {"status": "DUPLICATE", "message_id": message_id}
    try:
        body = DemoTransactionRequest.model_validate(payload)
    except ValidationError as exc:
        pubsub_stream.record(message_id, payload.get("transaction_id"), "REJECTED", str(exc.errors()[:2]), published)
        return {"status": "REJECTED", "message_id": message_id}
    from backend.api.transactions import ingest_transfer
    from backend.services.ai_insights import _window

    try:
        detail = ingest_transfer(body)
    except AppError as exc:
        status = "DUPLICATE" if exc.code == "DUPLICATE_TRANSACTION" else "REJECTED"
        pubsub_stream.record(message_id, body.transaction_id, status, exc.message, published)
        return {"status": status, "message_id": message_id, "detail": exc.message}
    with connect() as conn:
        analysis_service.run(conn, _window(conn))  # scored on arrival
    control = (detail.get("control") or {}).get("status")
    note = detail.get("message") if control else "Recorded and scored on arrival."
    pubsub_stream.record(message_id, body.transaction_id, control or "PROCESSED", note, published)
    return {"status": "PROCESSED", "message_id": message_id, "transaction_id": body.transaction_id, "control": control}


@router.get("/cloud/stream/events")
def stream_events(limit: int = Query(default=20, ge=1, le=100)) -> dict:
    return {"enabled": pubsub_stream.enabled(), "events": pubsub_stream.recent(limit)}


# ---- BigQuery ----

@router.post("/cloud/bigquery/sync", dependencies=[Depends(require_demo_token)])
def bigquery_sync_now() -> dict:
    _need(bigquery_sync.enabled(), "BigQuery")
    rows = bigquery_sync.sync_now()
    if not rows:
        raise AppError(502, "BIGQUERY_FAILED", "The BigQuery sync failed.", [{"detail": bigquery_sync.status["error"]}])
    return bigquery_sync.status


@router.post("/cloud/bigquery/ask")
def bigquery_question(body: AskRequest) -> dict:
    _need(bigquery_sync.enabled(), "BigQuery")
    question = " ".join(body.question.split())
    try:
        response = bigquery_ask.ask(question)
    except bigquery_ask.SqlRejected as exc:
        raise AppError(422, "SQL_REJECTED", "Gemini could not produce a safe query for that question.",
                       [{"reason": str(exc)[:300]}]) from None
    extra = {"question": question[:120]}
    if response["status"] == "OK":
        r = response["result"]
        extra.update(sql=r["sql"][:1500], rows=r["row_count"], bytes_billed=r["bytes_billed"], repairs=len(r["repairs"]))
    return ai_common.store(ai_common.PORTFOLIO, "BIGQUERY_ASK", {"question": question}, response, extra)


@router.get("/cloud/ml")
def ml_info() -> dict:
    return {"enabled": bigquery_ml.enabled(), **bigquery_ml.info()}


@router.post("/cloud/ml/train", status_code=202, dependencies=[Depends(require_demo_token)])
def ml_train() -> dict:
    _need(bigquery_ml.enabled(), "BigQuery ML")
    if bigquery_ml.status["state"] == "TRAINING":
        raise AppError(409, "ALREADY_TRAINING", "The model is already training.")
    bigquery_ml.train_async()
    return {"state": "TRAINING"}


@router.get("/cases/{case_id}/ml")
def case_ml(case_id: str) -> dict:
    with connect() as conn:
        case = _case_row(conn, case_id)
        scores = bigquery_ml.for_transactions(conn, case["transaction_ids"])
        rule = {r["transaction_id"]: r["score"] for r in conn.execute(
            f"SELECT transaction_id, score FROM risk_assessments WHERE transaction_id IN "
            f"({','.join('?' * len(case['transaction_ids']))})", case["transaction_ids"])}
    rows = sorted(({"transaction_id": t, "rule_score": rule.get(t), **s} for t, s in scores.items()),
                  key=lambda r: -r["probability"])
    top = rows[0] if rows else None
    agreement = None
    if top:
        ml_high, rule_high = top["probability"] >= 0.5, case["risk_score"] >= 60
        agreement = "AGREE" if ml_high == rule_high else ("MODEL_HIGHER" if ml_high else "RULES_HIGHER")
    return {"enabled": bigquery_ml.enabled(), "case_id": case_id, "transfers": rows, "top": top,
            "agreement": agreement, "case_rule_score": case["risk_score"]}


# ---- Vertex AI Search ----

@router.post("/cases/{case_id}/policy")
def case_policy(case_id: str) -> dict:
    _need(policy_search.enabled(), "Vertex AI Search")
    with connect() as conn:
        case = _case_row(conn, case_id)
    response = policy_search.guidance(case)
    return ai_common.store(case_id, "POLICY_GUIDANCE", {}, response,
                           {"passages": len((response.get("result") or {}).get("passages", []))})


@router.get("/cases/{case_id}/policy")
def get_case_policy(case_id: str) -> dict | None:
    with connect() as conn:
        _case_row(conn, case_id)
        return ai_common.latest(conn, case_id, "POLICY_GUIDANCE")
