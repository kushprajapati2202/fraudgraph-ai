"""AI endpoints beyond the case investigation: workspace insights (dashboard, settings) and case assistants.

GET endpoints never call Gemini: they return the latest stored result, or a rule-based one when nothing has been
generated yet. POST endpoints ask Gemini, fall back to rules when it is unavailable, and store the result.
"""
from fastapi import APIRouter

from backend.api.cases import _account_info, _case_row, _case_transactions, _evidence, _investigations
from backend.db import connect
from backend.errors import AppError, not_found
from backend.models.schemas import AskRequest, ContactScriptRequest, ExplainDayRequest, TranslateRequest
from backend.services import ai_common, ai_insights, case_ai, mitigation, red_team
from backend.services.ai_common import PORTFOLIO
from backend.services.analysis import load_transactions

router = APIRouter(tags=["ai"])


def _latest_or_rules(kind: str, compute) -> dict:
    with connect() as conn:
        stored = ai_common.latest(conn, PORTFOLIO, kind)
        if stored:
            return stored
        return ai_common.ephemeral(PORTFOLIO, kind, {}, compute(conn))


# ---- Workspace ----

@router.get("/ai/briefing")
def get_briefing() -> dict:
    return _latest_or_rules("BRIEFING", lambda conn: ai_insights.briefing(conn, use_ai=False))


@router.post("/ai/briefing")
def make_briefing() -> dict:
    with connect() as conn:
        response = ai_insights.briefing(conn, use_ai=True)
    return ai_common.store(PORTFOLIO, "BRIEFING", {}, response)


@router.get("/ai/patterns")
def get_patterns() -> dict:
    return _latest_or_rules("PATTERNS", lambda conn: ai_insights.patterns(conn, use_ai=False))


@router.post("/ai/patterns")
def make_patterns() -> dict:
    with connect() as conn:
        response = ai_insights.patterns(conn, use_ai=True)
    result = response["result"]
    return ai_common.store(PORTFOLIO, "PATTERNS", {}, response,
                           {"patterns": len(result["patterns"]), "method": result["method"]})


@router.post("/ai/explain-day")
def explain_day(body: ExplainDayRequest) -> dict:
    request = {"day": body.day}
    with connect() as conn:
        cached = None if body.refresh else ai_common.latest(conn, PORTFOLIO, "DAY_EXPLANATION", request)
        if cached and not cached["stale"]:
            return cached
        response = ai_insights.explain_day(conn, body.day)
    if response is None:
        raise not_found("Day", body.day)
    return ai_common.store(PORTFOLIO, "DAY_EXPLANATION", request, response, {"day": body.day})


@router.post("/ai/ask")
def ask(body: AskRequest) -> dict:
    question = " ".join(body.question.split())
    if len(question) < 3:
        raise AppError(422, "VALIDATION_ERROR", "Ask a question of at least 3 characters.", [{"field": "question"}])
    with connect() as conn:
        response = ai_insights.ask_portfolio(conn, question)
    return ai_common.store(PORTFOLIO, "ASK", {"question": question}, response,
                           {"question": question[:120], "target": response["result"]["plan"]["target"],
                            "results": response["result"]["total"]})


@router.get("/ai/rule-tuning")
def get_rule_tuning() -> dict:
    return _latest_or_rules("RULE_TUNING", lambda conn: ai_insights.rule_tuning(conn, use_ai=False))


@router.post("/ai/rule-tuning")
def make_rule_tuning() -> dict:
    with connect() as conn:
        response = ai_insights.rule_tuning(conn, use_ai=True)
    return ai_common.store(PORTFOLIO, "RULE_TUNING", {}, response,
                           {"suggestions": len(response["result"]["suggestions"]), "applied": False})


@router.get("/ai/red-team")
def get_red_team() -> dict:
    return _latest_or_rules("RED_TEAM", lambda conn: red_team.run(conn, use_ai=False))


@router.post("/ai/red-team")
def make_red_team() -> dict:
    with connect() as conn:
        response = red_team.run(conn, use_ai=True)
    r = response["result"]
    return ai_common.store(PORTFOLIO, "RED_TEAM", {}, response, {"tested": r["tested"], "evaded": r["evaded"]})


# ---- Case assistants ----

def _bundle(conn, case_id: str) -> dict:
    case = _case_row(conn, case_id)
    return {"case": case, "txs": _case_transactions(conn, case), "accounts": _account_info(conn, case["accounts"])}


@router.post("/cases/{case_id}/narrate")
def narrate(case_id: str) -> dict:
    with connect() as conn:
        b = _bundle(conn, case_id)
    response = case_ai.narrate(b["case"], b["txs"], b["accounts"])
    return ai_common.store(case_id, "NARRATION", {}, response)


@router.post("/cases/{case_id}/counterfactual")
def counterfactual(case_id: str) -> dict:
    with connect() as conn:
        b = _bundle(conn, case_id)
        rows = load_transactions(conn)
        window = ai_insights._window(conn)
    response = case_ai.counterfactual(b["case"], b["txs"], b["accounts"], rows, window)
    return ai_common.store(case_id, "COUNTERFACTUAL", {}, response)


@router.post("/cases/{case_id}/contact-script")
def contact_script(case_id: str, body: ContactScriptRequest) -> dict:
    with connect() as conn:
        b = _bundle(conn, case_id)
    if body.account_id not in b["case"]["accounts"]:
        raise AppError(422, "VALIDATION_ERROR", f"{body.account_id} is not part of this case.", [{"field": "account_id"}])
    response = case_ai.contact_script(b["case"], b["txs"], b["accounts"], body.account_id, body.channel, body.language)
    request = {"account_id": body.account_id, "channel": body.channel, "language": body.language}
    return ai_common.store(case_id, "CONTACT_SCRIPT", request, response, request)


@router.post("/cases/{case_id}/str")
def str_draft(case_id: str) -> dict:
    with connect() as conn:
        b = _bundle(conn, case_id)
        evidence = _evidence(conn, case_id)
        actions = [mitigation.present(dict(r)) for r in conn.execute(
            "SELECT * FROM mitigation_actions WHERE case_id = ? ORDER BY action_id", (case_id,))]
        decisions = [dict(r) for r in conn.execute(
            "SELECT * FROM analyst_decisions WHERE case_id = ? ORDER BY decision_id", (case_id,))]
    if not evidence:
        raise AppError(409, "NO_EVIDENCE", "This case has no evidence; run analysis first.")
    response = case_ai.str_draft(b["case"], b["txs"], b["accounts"], evidence, actions, decisions)
    return ai_common.store(case_id, "STR_DRAFT", {}, response, {"filed": False})


@router.post("/cases/{case_id}/translate")
def translate(case_id: str, body: TranslateRequest) -> dict:
    with connect() as conn:
        _case_row(conn, case_id)
        evidence = _evidence(conn, case_id)
        ok = [i for i in _investigations(conn, case_id, "INVESTIGATION", 10) if i["response"].get("status") == "OK"]
    if not ok:
        raise AppError(409, "NO_INVESTIGATION", "Run the Gemini investigation first; the translation is of its summary.")
    allowed = {e["evidence_id"] for e in evidence}
    response = case_ai.translate(ok[0]["response"]["result"], body.language, allowed)
    request = {"language": body.language, "investigation_id": ok[0]["investigation_id"]}
    return ai_common.store(case_id, "TRANSLATION", request, response, request)
