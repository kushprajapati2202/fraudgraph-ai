"""Personal "what to do next" list for the dashboard. Fixed, explainable rules; no AI needed.

Analysts are not user accounts: the name set in Settings is stored as actor_label on the decisions, actions and
resolutions they record, so that history is what the list is personalized from. The placeholder name "Analyst"
(or no name) gets a team-wide list instead.

Rules, most urgent first (each case appears once, under its most urgent reason):
  1. OVERDUE_TASK      an open task the analyst approved is past its due date
  2. TASK_DUE_SOON     an open task the analyst approved is due within TASK_DUE_SOON_DAYS
  3. HELD_TRANSFERS    transfers are waiting on a hold the analyst approved (grouped per account)
  4. FOLLOW_UP         the analyst's latest decision on a case was "request more evidence" and it is still pending
  5. SIMILAR_TO_ESCALATED  an open case shares warning signs with a case the analyst escalated
  6. HIGH_RISK_UNREVIEWED  the highest-scoring open cases fill any remaining slots
"""
import json
import sqlite3
from datetime import datetime, timedelta, timezone

from backend.services import mitigation
from backend.services.risk_engine import LABELS
from backend.services.similarity import CONTEXT_SIGNALS

DEFAULT_NAME = "Analyst"
MAX_ITEMS = 5
TASK_DUE_SOON_DAYS = 2
MIN_SHARED_SIGNALS = 2
MAX_SIMILAR = 2  # leave room for high-priority cases nobody has reviewed


def is_personal(analyst: str | None) -> bool:
    return bool(analyst and analyst.strip() and analyst.strip() != DEFAULT_NAME)


def _case_name(conn: sqlite3.Connection, title: str) -> str:
    """Pattern plus who the money came from, e.g. "Rapid onward movement from Asha Rao".

    Titles look like "<pattern> from AC-123 - 3 accounts, 4 transfers"; the pattern alone repeats across cases.
    """
    pattern, _, rest = title.split(" - ")[0].partition(" from ")
    row = conn.execute("SELECT holder_name FROM accounts WHERE account_id = ?", (rest.strip(),)).fetchone() if rest else None
    origin = row["holder_name"] if row and row["holder_name"] else rest.strip()
    return f"{pattern} from {origin}" if origin else pattern


def _days(n: int) -> str:
    return f"{n} {'day' if n == 1 else 'days'}"


def _due_text(due: datetime, now: datetime) -> str:
    days = (due.date() - now.date()).days
    if days < -1:
        return f"It was due {_days(-days)} ago."
    if days == -1:
        return "It was due yesterday."
    if days == 0:
        return "It is due today."
    if days == 1:
        return "It is due tomorrow."
    return f"It is due in {_days(days)}."


def _ago(ts: str, now: datetime) -> str:
    days = (now.date() - datetime.fromisoformat(ts).date()).days
    return "today" if days <= 0 else "yesterday" if days == 1 else f"{_days(days)} ago"


def _account_name(conn: sqlite3.Connection, account_id: str | None) -> str:
    if not account_id:
        return ""
    row = conn.execute("SELECT holder_name FROM accounts WHERE account_id = ?", (account_id,)).fetchone()
    return f"{row['holder_name']} ({account_id})" if row and row["holder_name"] else account_id


def _warning_signs(codes: set[str]) -> set[str]:
    return set(codes) - CONTEXT_SIGNALS


def recommend(conn: sqlite3.Connection, analyst: str | None) -> dict:
    personal = is_personal(analyst)
    me = analyst.strip() if personal else None
    now = datetime.now(timezone.utc)
    cases = {}
    for r in conn.execute("SELECT case_id, title, status, risk_score, risk_band, signal_codes_json, accounts_json "
                          "FROM cases WHERE active = 1"):
        d = dict(r)
        d["signal_codes"] = set(json.loads(d.pop("signal_codes_json")))
        d["accounts"] = json.loads(d.pop("accounts_json"))
        cases[d["case_id"]] = d

    items: list[dict] = []
    used: set[str] = set()

    def add(kind: str, case_id: str, title: str, reason: str, **extra) -> None:
        if case_id in used or case_id not in cases:
            return
        used.add(case_id)
        c = cases[case_id]
        items.append({"kind": kind, "case_id": case_id, "title": title, "reason": reason,
                      "risk_score": c["risk_score"], "risk_band": c["risk_band"], **extra})

    if personal:
        # Rules 1 and 2: open tasks this analyst approved, by due date.
        tasks = [mitigation.present(dict(r)) for r in conn.execute(
            "SELECT * FROM mitigation_actions WHERE status = 'OPEN' AND actor_label = ? ORDER BY created_at, action_id",
            (me,))]
        tasks = sorted((t for t in tasks if t["due_at"]), key=lambda t: t["due_at"])
        for t in tasks:
            due = datetime.fromisoformat(t["due_at"])
            target = f" for {_account_name(conn, t['target_account'])}" if t["target_account"] else ""
            reason = f"You approved this task {_ago(t['created_at'], now)}. {_due_text(due, now)}"
            if due < now:
                add("OVERDUE_TASK", t["case_id"], f"Overdue: {t['label']}{target}", reason,
                    account_id=t["target_account"], due_at=t["due_at"], queue=t["queue"])
        for t in tasks:
            due = datetime.fromisoformat(t["due_at"])
            if now <= due <= now + timedelta(days=TASK_DUE_SOON_DAYS):
                target = f" for {_account_name(conn, t['target_account'])}" if t["target_account"] else ""
                add("TASK_DUE_SOON", t["case_id"], f"Due soon: {t['label']}{target}",
                    f"You approved this task {_ago(t['created_at'], now)}. {_due_text(due, now)}",
                    account_id=t["target_account"], due_at=t["due_at"], queue=t["queue"])

    # Rule 3: transfers waiting on a hold (this analyst's holds, or everyone's on the team-wide list).
    held_sql = ("SELECT tc.case_id, tc.account_id, COUNT(*) AS n, COALESCE(SUM(t.amount), 0) AS total "
                "FROM transfer_controls tc JOIN transactions t ON t.transaction_id = tc.transaction_id "
                "JOIN mitigation_actions m ON m.action_id = tc.action_id WHERE tc.status = 'HELD' "
                + ("AND m.actor_label = ? " if personal else "")
                + "GROUP BY tc.case_id, tc.account_id ORDER BY n DESC, total DESC")
    for r in conn.execute(held_sql, (me,) if personal else ()):
        whose = "your hold" if personal else "a hold"
        add("HELD_TRANSFERS", r["case_id"],
            f"{r['n']} held {'transfer is' if r['n'] == 1 else 'transfers are'} waiting on {whose} for "
            f"{_account_name(conn, r['account_id'])}",
            "Release or reject them so the money isn't stuck longer than needed.",
            account_id=r["account_id"], count=r["n"], amount=r["total"])

    if personal:
        # Latest decision per case by this analyst.
        latest = {r["case_id"]: dict(r) for r in conn.execute(
            "SELECT d.case_id, d.decision, d.created_at FROM analyst_decisions d WHERE d.actor_label = ? AND "
            "d.decision_id = (SELECT MAX(decision_id) FROM analyst_decisions x WHERE x.case_id = d.case_id "
            "AND x.actor_label = d.actor_label)", (me,))}

        # Rule 4: cases this analyst parked waiting for more evidence.
        for cid, d in sorted(latest.items(), key=lambda kv: kv[1]["created_at"]):
            if d["decision"] == "REQUEST_MORE_EVIDENCE" and cases.get(cid, {}).get("status") == "NEEDS_EVIDENCE":
                add("FOLLOW_UP", cid, f"Follow up: {_case_name(conn, cases[cid]['title'])}",
                    f"You asked for more evidence {_ago(d['created_at'], now)}. Check whether it has arrived.")

        # Rule 5: open cases that look like ones this analyst escalated.
        escalated = [cases[cid] for cid, d in latest.items() if d["decision"] == "ESCALATE_FOR_REVIEW" and cid in cases]
        matches = []
        for c in cases.values():
            if c["status"] != "OPEN" or not escalated:
                continue
            best = max(escalated, key=lambda e: (len(_warning_signs(c["signal_codes"]) & _warning_signs(e["signal_codes"])),
                                                 e["risk_score"]))
            shared = sorted(_warning_signs(c["signal_codes"]) & _warning_signs(best["signal_codes"]))
            if len(shared) >= MIN_SHARED_SIGNALS:
                matches.append((len(shared), c["risk_score"], c, best, shared))
        for _, _, c, best, shared in sorted(matches, key=lambda m: (-m[0], -m[1], m[2]["case_id"]))[:MAX_SIMILAR]:
            signs = ", ".join(LABELS.get(s, s).lower() for s in shared)
            add("SIMILAR_TO_ESCALATED", c["case_id"], f"Looks like a case you escalated: {_case_name(conn, c['title'])}",
                f"Shares {len(shared)} warning signs ({signs}) with \"{_case_name(conn, best['title'])}\".",
                similar_case_id=best["case_id"])

    # Rule 6: highest-priority open cases nobody has reviewed yet.
    for c in sorted(cases.values(), key=lambda c: (-c["risk_score"], c["case_id"])):
        if len(items) >= MAX_ITEMS:
            break
        if c["status"] == "OPEN" and c["risk_band"] in ("HIGH", "MEDIUM"):
            add("HIGH_RISK_UNREVIEWED", c["case_id"],
                f"{'High' if c['risk_band'] == 'HIGH' else 'Medium'} priority, not reviewed yet: {_case_name(conn, c['title'])}",
                f"Priority score {c['risk_score']} out of 100. No analyst has recorded a decision.")

    return {"personalized": personal, "analyst": me, "items": items[:MAX_ITEMS]}
