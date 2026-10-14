import json

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


@router.get("/analysis/latest")
def latest_analysis() -> dict:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM analysis_runs ORDER BY created_at DESC, analysis_id DESC LIMIT 1").fetchone()
    if row is None:
        return {"analysis": None}
    d = dict(row)
    d["params"] = json.loads(d.pop("params_json"))
    d["diff"] = json.loads(d.pop("diff_json"))
    return {"analysis": d}
