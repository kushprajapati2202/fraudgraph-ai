from fastapi import APIRouter

from backend.db import connect
from backend.models.schemas import AnalysisRunRequest
from backend.services import analysis

router = APIRouter(tags=["analysis"])


@router.post("/analysis/run")
def run_analysis(body: AnalysisRunRequest | None = None) -> dict:
    body = body or AnalysisRunRequest()
    with connect() as conn:
        return analysis.run(conn, body.time_window_minutes, body.scenario_id)
