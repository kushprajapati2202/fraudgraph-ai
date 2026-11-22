"""Assistant chat sessions: the overview assistant's conversations, kept on the server.

Each answer is stored as an ai_insights record (kind ASSISTANT, audited like every AI result); a message row links it
to its session. Follow-up context comes from the session's stored turns, never from the browser.
"""
import secrets

from fastapi import APIRouter

from backend.db import connect, utcnow
from backend.errors import AppError, not_found
from backend.api.cases import _case_row, _evidence
from backend.models.schemas import AssistantAskRequest
from backend.services import ai_common, assistant
from backend.services.ai_common import PORTFOLIO

router = APIRouter(tags=["assistant"])

HISTORY_TURNS = 4
SESSION_LIST_LIMIT = 50


def _session(conn, session_id: str) -> dict:
    row = conn.execute(
        "SELECT s.*, (SELECT COUNT(*) FROM assistant_messages m WHERE m.session_id = s.session_id) AS messages "
        "FROM assistant_sessions s WHERE s.session_id = ?", (session_id,)).fetchone()
    if row is None:
        raise not_found("Chat", session_id)
    return dict(row)


def _messages(conn, session_id: str) -> list[dict]:
    out = []
    for m in conn.execute("SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY message_id", (session_id,)):
        out.append({"message_id": m["message_id"], "question": m["question"], "created_at": m["created_at"],
                    "insight": ai_common.get(conn, m["insight_id"])})
    return out


def _history(conn, session_id: str) -> list[dict]:
    """The last few answered turns, as the router sees them: the resolved question and the short reply."""
    turns = []
    for m in conn.execute("SELECT insight_id FROM assistant_messages WHERE session_id = ? ORDER BY message_id DESC "
                          "LIMIT ?", (session_id, HISTORY_TURNS)):
        rec = ai_common.get(conn, m["insight_id"])
        result = (rec or {}).get("response", {}).get("result")
        if result:
            turns.append({"question": result["standalone_question"], "answer": result["reply"][:400]})
    return turns[::-1]


def _title(question: str) -> str:
    return question if len(question) <= 60 else question[:57].rstrip() + "..."


@router.get("/assistant/sessions")
def list_sessions() -> dict:
    with connect() as conn:
        rows = conn.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM assistant_messages m WHERE m.session_id = s.session_id) AS messages "
            "FROM assistant_sessions s ORDER BY s.updated_at DESC, s.created_at DESC LIMIT ?", (SESSION_LIST_LIMIT,))
        return {"items": [dict(r) for r in rows]}


@router.get("/assistant/sessions/{session_id}")
def get_session(session_id: str) -> dict:
    with connect() as conn:
        return {"session": _session(conn, session_id), "messages": _messages(conn, session_id)}


@router.delete("/assistant/sessions/{session_id}")
def delete_session(session_id: str) -> dict:
    with connect(write=True) as conn:
        _session(conn, session_id)
        conn.execute("DELETE FROM assistant_messages WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM assistant_sessions WHERE session_id = ?", (session_id,))
    return {"deleted": session_id}


@router.post("/assistant/ask")
def ask(body: AssistantAskRequest) -> dict:
    """Answer one question in a chat. Without a session_id a new chat is started, titled by the question."""
    question = " ".join(body.question.split())
    if len(question) < 3:
        raise AppError(422, "VALIDATION_ERROR", "Ask a question of at least 3 characters.", [{"field": "question"}])
    now = utcnow()
    with connect() as conn:
        if body.session_id:
            session_id = _session(conn, body.session_id)["session_id"]
            history = _history(conn, session_id)
        else:
            session_id = f"CHAT-{secrets.token_hex(4).upper()}"
            conn.execute("INSERT INTO assistant_sessions(session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                         (session_id, _title(question), now, now))
            history = []
        case = evidence = None
        if body.case_id:
            case = _case_row(conn, body.case_id)
            evidence = _evidence(conn, body.case_id)
    with connect() as conn:
        response = assistant.answer(conn, question, history, case, evidence,
                                    load_case=lambda c, cid: (_case_row(c, cid), _evidence(c, cid)))

    extra = {"question": question[:120], "session_id": session_id, "case_id": body.case_id}
    if response["status"] == "OK":
        r = response["result"]
        extra.update(mode=r["mode"], routed_by=r["routed_by"], fell_back=bool(r["note"]))
        if r["analytics"]:
            extra.update(rows=r["analytics"]["row_count"], bytes_billed=r["analytics"]["bytes_billed"])
        elif r["lookup"]:
            extra.update(results=r["lookup"]["total"])
        if r.get("case"):
            extra.update(explained_case=r["case"]["case_id"], evidence_ids=r["case"]["evidence_ids"])
    insight = ai_common.store(PORTFOLIO, "ASSISTANT", {"question": question, "history": history,
                                                       "session_id": session_id, "case_id": body.case_id},
                              response, extra)
    with connect(write=True) as conn:
        # The chat may have been deleted while the answer was being generated.
        _session(conn, session_id)
        cur = conn.execute("INSERT INTO assistant_messages(session_id, question, insight_id, created_at) "
                           "VALUES (?, ?, ?, ?)", (session_id, question, insight["insight_id"], utcnow()))
        conn.execute("UPDATE assistant_sessions SET updated_at = ? WHERE session_id = ?", (utcnow(), session_id))
        return {"session": _session(conn, session_id),
                "message": {"message_id": cur.lastrowid, "question": question, "created_at": insight["created_at"],
                            "insight": insight}}
