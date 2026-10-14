"""Mitigation playbook: a fixed catalogue of proportionate actions, deterministic suggestions and their enforcement.

Suggestions (from the playbook or from Gemini) do nothing until a human analyst approves them. An approved action
then takes effect inside this workspace: a control (hold, enhanced monitoring) is applied to every transfer
submitted afterwards, and a follow-up (verification, KYC refresh, reports) becomes a task with an owner and a due
date. No external banking system is called. Gemini may only recommend codes from ACTION_CATALOG, so it cannot
invent new kinds of intervention.
"""
import sqlite3
from datetime import datetime, timedelta, timezone

from backend.db import utcnow
from backend.services import audit

CONTROL, TASK, RECORD = "CONTROL", "TASK", "RECORD"

ACTION_CATALOG: dict[str, dict] = {
    "HOLD_FOR_REVIEW": {
        "label": "Hold for manual review",
        "description": "Route pending or further transfers on the account to a manual review queue before release.",
        "needs_target": True,
        "kind": CONTROL,
        "effect": "New transfers to or from the account are held until an analyst releases or rejects them.",
    },
    "REQUEST_CUSTOMER_VERIFICATION": {
        "label": "Request customer verification",
        "description": "Contact the account holder through a verified channel to confirm the transfers and their purpose.",
        "needs_target": True,
        "kind": TASK,
        "queue": "Customer contact desk",
        "sla_days": 2,
    },
    "REQUEST_SOURCE_OF_FUNDS": {
        "label": "Request source-of-funds documents",
        "description": "Ask for documents that explain where the money came from (invoice, agreement, salary slip).",
        "needs_target": True,
        "kind": TASK,
        "queue": "Customer contact desk",
        "sla_days": 5,
    },
    "KYC_REFRESH": {
        "label": "Refresh KYC",
        "description": "Re-verify identity and upgrade a minimum-KYC account before higher-value activity continues.",
        "needs_target": True,
        "kind": TASK,
        "queue": "KYC operations",
        "sla_days": 7,
    },
    "ENHANCED_MONITORING": {
        "label": "Enhanced monitoring (30 days)",
        "description": "Lower alert thresholds on the account for a fixed period and review new activity daily.",
        "needs_target": True,
        "kind": CONTROL,
        "duration_days": 30,
        "effect": "Every new transfer on the account is flagged for review for 30 days, whatever its score.",
    },
    "NOTIFY_COUNTERPARTY_INSTITUTION": {
        "label": "Notify counterparty institution",
        "description": "Share the pattern with the receiving institution's fraud desk through the agreed channel.",
        "needs_target": False,
        "kind": TASK,
        "queue": "Fraud desk liaison",
        "sla_days": 1,
    },
    "FILE_INTERNAL_SUSPICION_REPORT": {
        "label": "File internal suspicion report",
        "description": "Send the case and evidence to the compliance team to decide whether a regulatory report is required.",
        "needs_target": False,
        "kind": TASK,
        "queue": "Compliance",
        "sla_days": 3,
    },
    "NO_ACTION": {
        "label": "No further action",
        "description": "Activity is adequately explained; close without intervention and keep the audit trail.",
        "needs_target": False,
        "kind": RECORD,
        "effect": "Recorded on the case. No control or task is created.",
    },
}

ACTION_CODES = tuple(ACTION_CATALOG)
RECENT_ACCOUNT_DAYS = 30
MAX_KYC_SUGGESTIONS = 3

# Action lifecycle: a control is ACTIVE until LIFTED, a task is OPEN until COMPLETED.
INITIAL_STATUS = {CONTROL: "ACTIVE", TASK: "OPEN", RECORD: "COMPLETED"}
CLOSED_STATUS = {CONTROL: "LIFTED", TASK: "COMPLETED"}
IN_EFFECT = ("ACTIVE", "OPEN")


def effect(code: str) -> str:
    meta = ACTION_CATALOG[code]
    if meta["kind"] == TASK:
        days = meta["sla_days"]
        return f"Opens a task for {meta['queue']}, due in {days} {'day' if days == 1 else 'days'}."
    return meta["effect"]


def catalog() -> list[dict]:
    return [{"code": code, **meta, "effect": effect(code)} for code, meta in ACTION_CATALOG.items()]


def present(action: dict) -> dict:
    """An action row plus what the catalogue says about it: label, kind, owning queue, due or expiry date."""
    meta = ACTION_CATALOG.get(action["action_code"], {})
    created = datetime.fromisoformat(action["created_at"])
    due = created + timedelta(days=meta["sla_days"]) if meta.get("sla_days") else None
    expires = created + timedelta(days=meta["duration_days"]) if meta.get("duration_days") else None
    return {**action, "label": meta.get("label", action["action_code"]), "kind": meta.get("kind"),
            "queue": meta.get("queue"), "due_at": due.isoformat() if due else None,
            "expires_at": expires.isoformat() if expires else None}


def active_controls(conn: sqlite3.Connection, account_ids: list[str]) -> list[dict]:
    """Controls currently in force on any of the accounts, oldest first. Expired monitoring is left out."""
    if not account_ids:
        return []
    marks = ",".join("?" * len(account_ids))
    now = datetime.now(timezone.utc)
    out = []
    for r in conn.execute(f"SELECT * FROM mitigation_actions WHERE status = 'ACTIVE' AND target_account IN ({marks}) "
                          f"ORDER BY action_id", account_ids):
        action = present(dict(r))
        if action["kind"] != CONTROL:
            continue
        if action["expires_at"] and datetime.fromisoformat(action["expires_at"]) <= now:
            continue
        out.append(action)
    return out


def apply_controls(conn: sqlite3.Connection, tx: dict) -> dict | None:
    """Enforce the controls on a newly submitted transfer. A hold on either party takes precedence over monitoring.

    Returns the control record written for the transfer, or None when neither account is under a control.
    """
    controls = active_controls(conn, [tx["source_account"], tx["destination_account"]])
    if not controls:
        return None
    chosen = next((c for c in controls if c["action_code"] == "HOLD_FOR_REVIEW"), controls[0])
    held = chosen["action_code"] == "HOLD_FOR_REVIEW"
    record = {"transaction_id": tx["transaction_id"], "action_id": chosen["action_id"], "case_id": chosen["case_id"],
              "account_id": chosen["target_account"], "control": chosen["action_code"],
              "status": "HELD" if held else "FLAGGED", "created_at": utcnow(), "resolved_at": None,
              "resolved_by": None, "resolution_note": None}
    conn.execute(
        "INSERT INTO transfer_controls(transaction_id, action_id, case_id, account_id, control, status, created_at) "
        "VALUES (:transaction_id, :action_id, :case_id, :account_id, :control, :status, :created_at)", record)
    audit.record(conn, "TRANSFER_HELD" if held else "TRANSFER_FLAGGED", audit.ACTOR_SYSTEM, {
        "transaction_id": tx["transaction_id"], "amount": tx["amount"], "source_account": tx["source_account"],
        "destination_account": tx["destination_account"], "account_id": chosen["target_account"],
        "action_id": chosen["action_id"], "control": chosen["action_code"],
    }, chosen["case_id"])
    return record


def suggest(case: dict, transactions: list[dict], accounts: dict[str, dict]) -> list[dict]:
    """Deterministic, explainable suggestions derived from the signals that fired. Always available (no AI needed).

    `transactions` are the case transfers with their `signals`; `accounts` maps account_id -> account row.
    """
    codes = set(case["signal_codes"])
    ordered = sorted(transactions, key=lambda t: (t["timestamp"], t["transaction_id"]))
    if not ordered:
        return []
    origin = ordered[0]["source_account"]
    last_dest = ordered[-1]["destination_account"]
    out: list[dict] = []

    def add(code: str, target: str | None, rationale: str, basis: list[str]) -> None:
        if not any(s["action_code"] == code and s["target_account"] == target for s in out):
            out.append({"action_code": code, "label": ACTION_CATALOG[code]["label"], "target_account": target,
                        "rationale": rationale, "basis": basis, "source": "PLAYBOOK"})

    if codes & {"RAPID_ONWARD", "FAN_IN_RAPID_OUT"}:
        add("HOLD_FOR_REVIEW", last_dest,
            f"Funds reached {last_dest} after moving onward quickly through the case accounts; holding further "
            f"transfers there keeps the money reviewable.", sorted(codes & {"RAPID_ONWARD", "FAN_IN_RAPID_OUT"}))
    if "UNUSUAL_AMOUNT" in codes or "VELOCITY" in codes:
        add("REQUEST_CUSTOMER_VERIFICATION", origin,
            f"The first transfers came from {origin} and were unusual for that account; confirming them with the "
            f"holder is the fastest way to rule out account takeover or a mistake.",
            sorted(codes & {"UNUSUAL_AMOUNT", "VELOCITY"}))
    if "UNUSUAL_AMOUNT" in codes and case["risk_band"] != "HIGH":
        add("REQUEST_SOURCE_OF_FUNDS", origin,
            "A large transfer with a plausible legitimate purpose is usually resolved by supporting documents.",
            ["UNUSUAL_AMOUNT"])


    if case["risk_band"] == "HIGH":
        add("FILE_INTERNAL_SUSPICION_REPORT", None,
            "High-priority pattern across several accounts; compliance should decide whether external reporting applies.",
            sorted(codes - {"RELATIONSHIP_NOVELTY"}))
    else:
        add("ENHANCED_MONITORING", origin,
            "Medium-priority pattern: closer monitoring is proportionate while more evidence is gathered.",
            sorted(codes - {"RELATIONSHIP_NOVELTY"}))
    # Recently opened minimum-KYC accounts, most recently opened first (capped so the list stays reviewable).
    first_ts = ordered[0]["timestamp"][:10]
    recent = []
    for acc_id in case["accounts"]:
        acc = accounts.get(acc_id) or {}
        opened = acc.get("created_at") or ""
        if acc.get("kyc_tier") == "MIN_KYC" and opened and 0 <= _days_between(opened, first_ts) <= RECENT_ACCOUNT_DAYS:
            recent.append((opened, acc_id))
    for opened, acc_id in sorted(recent, reverse=True)[:MAX_KYC_SUGGESTIONS]:
        add("KYC_REFRESH", acc_id,
            f"{acc_id} is a minimum-KYC account opened on {opened}, shortly before this activity.",
            ["ACCOUNT_AGE", "KYC_TIER"])
    return out


def _days_between(earlier: str, later: str) -> int:
    from datetime import date

    try:
        return (date.fromisoformat(later[:10]) - date.fromisoformat(earlier[:10])).days
    except ValueError:
        return 10**6
