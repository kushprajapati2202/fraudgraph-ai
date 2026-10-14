import json
from typing import Literal

from fastapi import APIRouter, Query

from backend.db import connect, dumps, utcnow
from backend.errors import AppError, not_found
import re

from backend.models.schemas import (DECISION_TO_STATUS, ActionRequest, ChatRequest, CloseActionRequest, DecisionRequest,
                                    DocumentRequest, HeldTransferRequest, InvestigateRequest)
from backend.services import audit, document_check, gemini_service, mitigation, similarity

router = APIRouter(tags=["cases"])


def _case_row(conn, case_id: str) -> dict:
    row = conn.execute("SELECT * FROM cases WHERE case_id = ?", (case_id,)).fetchone()
    if row is None:
        raise not_found("Case", case_id[:40])
    case = dict(row)
    case["transaction_ids"] = json.loads(case.pop("transaction_ids_json"))
    case["accounts"] = json.loads(case.pop("accounts_json"))
    case["signal_codes"] = json.loads(case.pop("signal_codes_json"))
    case["active"] = bool(case["active"])
    return case


def _case_stats(conn, tx_ids: list[str]) -> dict:
    """Amount moved, time span and the originating account for a case's transfers."""
    marks = ",".join("?" * len(tx_ids))
    agg = conn.execute(f"SELECT COALESCE(SUM(amount), 0) AS total, MIN(timestamp) AS first, MAX(timestamp) AS last "
                       f"FROM transactions WHERE transaction_id IN ({marks})", tx_ids).fetchone()
    origin = conn.execute(
        f"SELECT t.source_account, a.holder_name FROM transactions t LEFT JOIN accounts a ON a.account_id = t.source_account "
        f"WHERE t.transaction_id IN ({marks}) ORDER BY t.timestamp, t.transaction_id LIMIT 1", tx_ids).fetchone()
    return {
        "total_amount": agg["total"], "first_activity": agg["first"], "last_activity": agg["last"],
        "origin_account": origin["source_account"] if origin else None,
        "origin_name": origin["holder_name"] if origin else None,
    }


def _evidence(conn, case_id: str) -> list[dict]:
    items = []
    for r in conn.execute("SELECT * FROM case_evidence WHERE case_id = ? ORDER BY sort_order", (case_id,)):
        d = dict(r)
        d["payload"] = json.loads(d.pop("payload_json"))
        items.append(d)
    return items


def _controlled_transfers(conn, case_id: str) -> list[dict]:
    """Transfers stopped or flagged by a control approved on this case, newest first."""
    return [dict(r) for r in conn.execute(
        "SELECT tc.*, t.amount, t.currency, t.timestamp, t.source_account, t.destination_account, "
        "sa.holder_name AS source_name, da.holder_name AS destination_name FROM transfer_controls tc "
        "JOIN transactions t ON t.transaction_id = tc.transaction_id "
        "LEFT JOIN accounts sa ON sa.account_id = t.source_account "
        "LEFT JOIN accounts da ON da.account_id = t.destination_account "
        "WHERE tc.case_id = ? ORDER BY tc.created_at DESC, tc.transaction_id", (case_id,))]


def _investigations(conn, case_id: str, kind: str, limit: int) -> list[dict]:
    out = []
    for r in conn.execute("SELECT * FROM ai_investigations WHERE case_id = ? AND kind = ? "
                          "ORDER BY investigation_id DESC LIMIT ?", (case_id, kind, limit)):
        d = dict(r)
        d["response"] = json.loads(d.pop("result_json"))
        out.append(d)
    return out


@router.get("/cases")
def list_cases(
    risk_band: Literal["LOW", "MEDIUM", "HIGH"] | None = None,
    status: Literal["OPEN", "ESCALATED", "DISMISSED", "NEEDS_EVIDENCE"] | None = None,
    search: str | None = Query(default=None, max_length=64),
    include_inactive: bool = False,
) -> dict:
    where, params = [], []
    if not include_inactive:
        where.append("active = 1")
    if risk_band:
        where.append("risk_band = ?")
        params.append(risk_band)
    if status:
        where.append("status = ?")
        params.append(status)
    if search:
        where.append("(case_id LIKE ? OR title LIKE ? OR accounts_json LIKE ? OR transaction_ids_json LIKE ?)")
        params += [f"%{search}%"] * 4
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with connect() as conn:
        rows = conn.execute(f"SELECT * FROM cases {clause} ORDER BY risk_score DESC, updated_at DESC, case_id",
                            params).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            tx_ids = json.loads(d.pop("transaction_ids_json"))
            d["transaction_count"] = len(tx_ids)
            d["account_count"] = len(json.loads(d.pop("accounts_json")))
            d.update(_case_stats(conn, tx_ids))
            d["signal_codes"] = json.loads(d.pop("signal_codes_json"))
            d["active"] = bool(d["active"])
            last = conn.execute("SELECT decision, created_at FROM analyst_decisions WHERE case_id = ? "
                                "ORDER BY decision_id DESC LIMIT 1", (d["case_id"],)).fetchone()
            d["latest_decision"] = dict(last) if last else None
            items.append(d)
    return {"items": items, "total": len(items)}


@router.get("/cases/{case_id}")
def get_case(case_id: str) -> dict:
    with connect() as conn:
        case = _case_row(conn, case_id)
        marks = ",".join("?" * len(case["transaction_ids"]))
        txs = []
        for r in conn.execute(
            f"SELECT t.*, ra.score, ra.risk_band, ra.signals_json, ra.uncertainties_json, tc.status AS control_status, "
            f"sa.holder_name AS source_name, da.holder_name AS destination_name FROM transactions t "
            f"LEFT JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id "
            f"LEFT JOIN transfer_controls tc ON tc.transaction_id = t.transaction_id "
            f"LEFT JOIN accounts sa ON sa.account_id = t.source_account "
            f"LEFT JOIN accounts da ON da.account_id = t.destination_account "
            f"WHERE t.transaction_id IN ({marks}) ORDER BY t.timestamp, t.transaction_id", case["transaction_ids"]):
            d = dict(r)
            d["signals"] = json.loads(d.pop("signals_json") or "[]")
            d["uncertainties"] = json.loads(d.pop("uncertainties_json") or '{"uncertainties": []}')["uncertainties"]
            txs.append(d)
        labels = [dict(r) for r in conn.execute(
            f"SELECT scenario_id, label, COUNT(*) AS n FROM labels WHERE transaction_id IN ({marks}) "
            f"GROUP BY scenario_id, label", case["transaction_ids"])]
        decisions = [dict(r) for r in conn.execute(
            "SELECT * FROM analyst_decisions WHERE case_id = ? ORDER BY decision_id", (case_id,))]
        events = []
        for r in conn.execute("SELECT * FROM audit_events WHERE case_id = ? ORDER BY event_id", (case_id,)):
            d = dict(r)
            d["event_payload"] = json.loads(d["event_payload"])
            events.append(d)
        case.update(_case_stats(conn, case["transaction_ids"]))
        acc_marks = ",".join("?" * len(case["accounts"]))
        account_info = {r["account_id"]: dict(r) for r in conn.execute(
            f"SELECT account_id, holder_name, account_type, city, kyc_tier, created_at, account_number FROM accounts "
            f"WHERE account_id IN ({acc_marks})", case["accounts"])}
        investigation = _investigations(conn, case_id, "INVESTIGATION", 1)
        report = _investigations(conn, case_id, "REPORT", 1)
        documents = []
        for r in conn.execute("SELECT * FROM case_documents WHERE case_id = ? ORDER BY document_id DESC", (case_id,)):
            doc = dict(r)
            doc["response"] = json.loads(doc.pop("result_json"))
            documents.append(doc)
        actions = [mitigation.present(dict(r)) for r in conn.execute(
            "SELECT * FROM mitigation_actions WHERE case_id = ? ORDER BY action_id", (case_id,))]
        controlled = _controlled_transfers(conn, case_id)
        account_controls: dict[str, list[dict]] = {}
        for control in mitigation.active_controls(conn, case["accounts"]):
            account_controls.setdefault(control["target_account"], []).append(
                {k: control[k] for k in ("action_id", "action_code", "label", "case_id", "created_at", "expires_at")})
        chats = list(reversed(_investigations(conn, case_id, "CHAT", 20)))
        evidence = _evidence(conn, case_id)

    signal_summary: dict[str, dict] = {}
    for t in txs:
        for s in t["signals"]:
            agg = signal_summary.setdefault(s["code"], {"code": s["code"], "label": s["label"], "weight": s["weight"],
                                                        "context_only": s["context_only"], "transactions": 0,
                                                        "max_contribution": 0.0})
            agg["transactions"] += 1
            agg["max_contribution"] = max(agg["max_contribution"], s["contribution"])
    uncertainties = sorted({u for t in txs for u in t["uncertainties"]})
    return {
        "case": case,
        "accounts": account_info,
        "transactions": txs,
        "signal_summary": sorted(signal_summary.values(), key=lambda s: -s["max_contribution"]),
        "uncertainties": uncertainties,
        "evidence": evidence,
        "decisions": decisions,
        "audit_events": events,
        "latest_investigation": investigation[0] if investigation else None,
        "latest_report": report[0] if report else None,
        "suggested_actions": mitigation.suggest(case, txs, account_info),
        "actions": actions,
        "controlled_transfers": controlled,
        "account_controls": account_controls,
        "action_catalog": mitigation.catalog(),
        "documents": documents,
        "chat_history": chats,
        "ground_truth": labels,
        "ground_truth_note": "Synthetic scenario labels for evaluation only; not used by the risk engine or Gemini.",
    }


def _load_for_ai(case_id: str) -> tuple[dict, list[dict]]:
    with connect() as conn:
        case = _case_row(conn, case_id)
        return case, _evidence(conn, case_id)


def _store_ai(case_id: str, kind: str, question: str | None, response: dict) -> dict:
    now = utcnow()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO ai_investigations(case_id, kind, status, model, prompt_version, question, result_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (case_id, kind, response["status"], response.get("model"), response["prompt_version"], question,
             dumps(response), now),
        )
        validation = response.get("validation") or {}
        audit.record(conn, f"AI_{kind}", audit.ACTOR_AI, {
            "status": response["status"], "reason": response.get("reason"), "model": response.get("model"),
            "prompt_version": response["prompt_version"],
            "removed_evidence_ids": validation.get("removed_ids", []),
            "unsupported_claims": len(validation.get("unsupported_claims", [])),
            "advisory_only": True,
        }, case_id)
    return {"investigation_id": cur.lastrowid, "created_at": now, "kind": kind, "question": question, "response": response}


@router.post("/cases/{case_id}/investigate")
def investigate(case_id: str, body: InvestigateRequest | None = None) -> dict:
    question = body.question.strip() if body and body.question else None
    case, evidence = _load_for_ai(case_id)
    if not evidence:
        raise AppError(409, "NO_EVIDENCE", "This case has no evidence; run analysis first.")
    response = gemini_service.investigate(case, evidence, question)
    return _store_ai(case_id, "INVESTIGATION", question, response)


@router.post("/cases/{case_id}/chat")
def chat(case_id: str, body: ChatRequest) -> dict:
    message = body.message.strip()
    if not message:
        raise AppError(422, "VALIDATION_ERROR", "Message must not be empty.", [{"field": "message"}])
    case, evidence = _load_for_ai(case_id)
    if not evidence:
        raise AppError(409, "NO_EVIDENCE", "This case has no evidence; run analysis first.")
    response = gemini_service.chat(case, evidence, message)
    return _store_ai(case_id, "CHAT", message, response)


@router.post("/cases/{case_id}/decision", status_code=201)
def record_decision(case_id: str, body: DecisionRequest) -> dict:
    rationale = body.rationale.strip()
    if len(rationale) < 5:
        raise AppError(422, "VALIDATION_ERROR", "A rationale of at least 5 characters is required.",
                       [{"field": "rationale"}])
    actor = (body.actor_label or "Analyst").strip()
    now = utcnow()
    with connect() as conn:
        case = _case_row(conn, case_id)
        status = DECISION_TO_STATUS[body.decision]
        cur = conn.execute(
            "INSERT INTO analyst_decisions(case_id, decision, rationale, actor_label, created_at) VALUES (?, ?, ?, ?, ?)",
            (case_id, body.decision.value, rationale, actor, now),
        )
        conn.execute("UPDATE cases SET status = ?, updated_at = ? WHERE case_id = ?", (status, now, case_id))
        audit.record(conn, "ANALYST_DECISION", audit.ACTOR_HUMAN, {
            "decision_id": cur.lastrowid, "decision": body.decision.value, "rationale": rationale,
            "actor_label": actor, "status_before": case["status"], "status_after": status,
        }, case_id)
    return {
        "decision": {"decision_id": cur.lastrowid, "case_id": case_id, "decision": body.decision.value,
                     "rationale": rationale, "actor_label": actor, "created_at": now},
        "case_status": status,
    }


@router.post("/cases/{case_id}/report")
def draft_report(case_id: str) -> dict:
    """AI-drafted internal escalation report with catalogue-only recommended actions (validated; advisory)."""
    case, evidence = _load_for_ai(case_id)
    if not evidence:
        raise AppError(409, "NO_EVIDENCE", "This case has no evidence; run analysis first.")
    response = gemini_service.report(case, evidence, mitigation.catalog())
    return _store_ai(case_id, "REPORT", None, response)


@router.post("/cases/{case_id}/actions", status_code=201)
def approve_action(case_id: str, body: ActionRequest) -> dict:
    """A human approves a mitigation action and it takes effect in this workspace.

    A control (hold, monitoring) applies to transfers submitted from now on; a follow-up becomes an open task.
    No external system is called.
    """
    meta = mitigation.ACTION_CATALOG[body.action_code]
    status = mitigation.INITIAL_STATUS[meta["kind"]]
    effect = mitigation.effect(body.action_code)
    actor = (body.actor_label or "Analyst").strip()
    note = body.note.strip() if body.note else None
    now = utcnow()
    with connect() as conn:
        case = _case_row(conn, case_id)
        if body.target_account and body.target_account not in case["accounts"]:
            raise AppError(422, "VALIDATION_ERROR", f"{body.target_account} is not part of this case.",
                           [{"field": "target_account"}])
        if meta["needs_target"] and not body.target_account:
            raise AppError(422, "VALIDATION_ERROR", f"'{meta['label']}' needs a target account from this case.",
                           [{"field": "target_account"}])
        # The same action can be approved again once the earlier one has been lifted or completed.
        still_open = "1 = 1" if meta["kind"] == mitigation.RECORD else "status IN ('ACTIVE', 'OPEN')"
        duplicate = conn.execute(
            f"SELECT 1 FROM mitigation_actions WHERE case_id = ? AND action_code = ? AND COALESCE(target_account, '') = ? "
            f"AND {still_open}", (case_id, body.action_code, body.target_account or "")).fetchone()
        if duplicate:
            raise AppError(409, "DUPLICATE_ACTION", "This action is already in effect for this case.")
        cur = conn.execute(
            "INSERT INTO mitigation_actions(case_id, action_code, target_account, note, source, status, actor_label, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (case_id, body.action_code, body.target_account, note, body.source, status, actor, now),
        )
        audit.record(conn, "MITIGATION_ACTION_APPROVED", audit.ACTOR_HUMAN, {
            "action_id": cur.lastrowid, "action_code": body.action_code, "label": meta["label"],
            "target_account": body.target_account, "recommended_by": body.source, "actor_label": actor, "note": note,
            "kind": meta["kind"], "status": status, "effect": effect, "executed_externally": False,
        }, case_id)
        action = mitigation.present(dict(conn.execute(
            "SELECT * FROM mitigation_actions WHERE action_id = ?", (cur.lastrowid,)).fetchone()))
    return {"action": action, "effect": effect}


@router.post("/cases/{case_id}/actions/{action_id}/close")
def close_action(case_id: str, action_id: int, body: CloseActionRequest) -> dict:
    """Lift a control or complete a task, with the outcome. Transfers already held stay held until resolved."""
    actor = (body.actor_label or "Analyst").strip()
    outcome = body.outcome.strip()
    now = utcnow()
    with connect() as conn:
        _case_row(conn, case_id)
        row = conn.execute("SELECT * FROM mitigation_actions WHERE action_id = ? AND case_id = ?",
                           (action_id, case_id)).fetchone()
        if row is None:
            raise not_found("Action", str(action_id))
        if row["status"] not in mitigation.IN_EFFECT:
            raise AppError(409, "ACTION_CLOSED", "This action has already been closed.")
        meta = mitigation.ACTION_CATALOG[row["action_code"]]
        status = mitigation.CLOSED_STATUS[meta["kind"]]
        conn.execute("UPDATE mitigation_actions SET status = ?, closed_at = ?, closed_by = ?, outcome = ? "
                     "WHERE action_id = ?", (status, now, actor, outcome, action_id))
        audit.record(conn, "MITIGATION_ACTION_CLOSED", audit.ACTOR_HUMAN, {
            "action_id": action_id, "action_code": row["action_code"], "label": meta["label"],
            "target_account": row["target_account"], "status": status, "outcome": outcome, "actor_label": actor,
        }, case_id)
        action = mitigation.present(dict(conn.execute(
            "SELECT * FROM mitigation_actions WHERE action_id = ?", (action_id,)).fetchone()))
    return {"action": action}


@router.post("/cases/{case_id}/held-transfers/{transaction_id}")
def resolve_held_transfer(case_id: str, transaction_id: str, body: HeldTransferRequest) -> dict:
    """An analyst releases a held transfer or rejects it. Either way the reason is recorded and audited."""
    actor = (body.actor_label or "Analyst").strip()
    note = body.note.strip()
    now = utcnow()
    status = "RELEASED" if body.resolution == "RELEASE" else "REJECTED"
    with connect() as conn:
        _case_row(conn, case_id)
        row = conn.execute(
            "SELECT tc.*, t.amount FROM transfer_controls tc JOIN transactions t ON t.transaction_id = tc.transaction_id "
            "WHERE tc.transaction_id = ? AND tc.case_id = ?", (transaction_id, case_id)).fetchone()
        if row is None:
            raise not_found("Held transfer", transaction_id[:40])
        if row["status"] != "HELD":
            raise AppError(409, "NOT_HELD", f"This transfer is not on hold (status {row['status']}).")
        conn.execute("UPDATE transfer_controls SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ? "
                     "WHERE transaction_id = ?", (status, now, actor, note, transaction_id))
        audit.record(conn, "HELD_TRANSFER_RESOLVED", audit.ACTOR_HUMAN, {
            "transaction_id": transaction_id, "amount": row["amount"], "account_id": row["account_id"],
            "status": status, "note": note, "actor_label": actor,
        }, case_id)
    return {"transfer": {**dict(row), "status": status, "resolved_at": now, "resolved_by": actor,
                         "resolution_note": note}}

@router.post("/cases/{case_id}/documents", status_code=201)
def verify_document(case_id: str, body: DocumentRequest) -> dict:
    """Read a supporting document with Gemini (multimodal) and compare it with a transfer in this case.

    Extraction is done by the model; the comparison and verdict are computed in code. The file is not stored.
    """
    try:
        raw = document_check.decode_upload(body.data_base64, body.mime_type)
    except document_check.DocumentError as exc:
        raise AppError(422, "VALIDATION_ERROR", exc.message, [{"field": exc.field}]) from None
    filename = re.sub(r"[^A-Za-z0-9 ._\-()]", "_", body.filename)[:120]
    with connect() as conn:
        case = _case_row(conn, case_id)
        if body.transaction_id not in case["transaction_ids"]:
            raise AppError(422, "VALIDATION_ERROR", f"{body.transaction_id} is not part of this case.",
                           [{"field": "transaction_id"}])
        tx = dict(conn.execute(
            "SELECT t.*, sa.holder_name AS source_name, da.holder_name AS destination_name FROM transactions t "
            "LEFT JOIN accounts sa ON sa.account_id = t.source_account "
            "LEFT JOIN accounts da ON da.account_id = t.destination_account WHERE t.transaction_id = ?",
            (body.transaction_id,)).fetchone())

    response = document_check.analyse(raw, body.mime_type, tx, tx["source_name"], tx["destination_name"])
    actor = (body.actor_label or "Analyst").strip()
    now = utcnow()
    digest = document_check.sha256(raw)
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO case_documents(case_id, transaction_id, filename, mime_type, size_bytes, sha256, status, verdict, "
            "result_json, actor_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (case_id, body.transaction_id, filename, body.mime_type, len(raw), digest, response["status"],
             response.get("verdict"), dumps(response), actor, now),
        )
        audit.record(conn, "AI_DOCUMENT_CHECK", audit.ACTOR_AI, {
            "document_id": cur.lastrowid, "filename": filename, "sha256": digest[:16], "transaction_id": body.transaction_id,
            "status": response["status"], "reason": response.get("reason"), "verdict": response.get("verdict"),
            "model": response.get("model"), "uploaded_by": actor, "file_stored": False, "advisory_only": True,
        }, case_id)
    return {"document_id": cur.lastrowid, "case_id": case_id, "transaction_id": body.transaction_id, "filename": filename,
            "mime_type": body.mime_type, "size_bytes": len(raw), "sha256": digest, "status": response["status"],
            "verdict": response.get("verdict"), "actor_label": actor, "created_at": now, "response": response}

@router.get("/cases/{case_id}/similar")
def similar_cases(case_id: str) -> dict:
    """Resolved cases with a similar pattern (Gemini embeddings; falls back to rule-signal overlap)."""
    with connect() as conn:
        case = _case_row(conn, case_id)
        marks = ",".join("?" * len(case["transaction_ids"]))
        txs = [dict(r) for r in conn.execute(
            f"SELECT transaction_id, source_account, destination_account, amount, timestamp FROM transactions "
            f"WHERE transaction_id IN ({marks})", case["transaction_ids"])]
        acc_marks = ",".join("?" * len(case["accounts"]))
        accounts = {r["account_id"]: dict(r) for r in conn.execute(
            f"SELECT account_id, account_type, created_at, kyc_tier FROM accounts WHERE account_id IN ({acc_marks})",
            case["accounts"])}
        return {"case_id": case_id, **similarity.find_similar(conn, case, txs, accounts)}