from fastapi import APIRouter

from backend.config import APP_VERSION, settings
from backend.db import connect, get_meta
from backend.services import dataset, gemini_service, risk_engine

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    with connect() as conn:
        loaded = dataset.is_loaded(conn)
        dataset_version = get_meta(conn, "dataset_version") if loaded else None
    return {
        "status": "ok",
        "app_version": APP_VERSION,
        "dataset_version": dataset_version,
        "data_loaded": loaded,
        "rule_version": risk_engine.RULE_VERSION,
        "prompt_version": gemini_service.PROMPT_VERSION,
        "gemini_configured": settings.gemini_configured,
        "gemini_model": settings.gemini_model,
        "gemini_backend": settings.gemini_backend_name if settings.gemini_configured else None,
        "demo_token_required": bool(settings.demo_token),
    }


@router.get("/ai/status")
def ai_status(refresh: bool = False) -> dict:
    """Live Gemini connectivity check (cached ~2 min). Reports why AI is unavailable; never returns the key."""
    return gemini_service.check_connection(force=refresh)


@router.get("/rules")
def rules() -> dict:
    return {
        "rule_version": risk_engine.RULE_VERSION,
        "bands": risk_engine.BAND_THRESHOLDS,
        "case_min_score": risk_engine.CASE_MIN_SCORE,
        "rules": risk_engine.rules_description(),
        "note": "The score is a rule-based prioritization index, not a calibrated probability of fraud.",
    }
