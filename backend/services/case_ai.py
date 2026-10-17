"""Case-level AI beyond the investigation: flow narration, counterfactual scoring, customer contact scripts,
STR-style regulatory drafts and translated summaries.

As everywhere else, numbers and record fields come from the database. Gemini writes captions, explanations and
wording; every transfer or evidence ID it returns must belong to the case. Customer-facing text is filtered in code
for requests for secrets and for wording that could tip off the customer.
"""
import json
import re
from datetime import date
from typing import Literal

from pydantic import BaseModel

from backend.services import ai_common, gemini_service, mitigation, risk_engine
from backend.services.ai_common import Ids, TX_ID_PATTERN, facts_prompt, from_gemini, from_rules, inr, trunc, unavailable
from backend.services.risk_engine import CASE_MIN_SCORE, LABELS, risk_band

LANGUAGES = {"en": "English", "hi": "Hindi", "gu": "Gujarati", "mr": "Marathi", "ta": "Tamil", "te": "Telugu",
             "bn": "Bengali", "kn": "Kannada"}


def _ordered(txs: list[dict]) -> list[dict]:
    return sorted(txs, key=lambda t: (t["timestamp"], t["transaction_id"]))


def _name(accounts: dict, acc: str) -> str:
    return (accounts.get(acc) or {}).get("holder_name") or acc


def _age_days(accounts: dict, acc: str, ts: str) -> int | None:
    try:
        return (date.fromisoformat(ts[:10]) - date.fromisoformat(((accounts.get(acc) or {}).get("created_at") or "")[:10])).days
    except ValueError:
        return None


def _minutes(a: str, b: str) -> int:
    return int((risk_engine.parse_ts(b) - risk_engine.parse_ts(a)).total_seconds() // 60)


# ---- 1. Narrated money flow ----

class StepCaption(BaseModel):
    transaction_id: str
    caption: str


class Narration(BaseModel):
    overview: str
    steps: list[StepCaption]
    takeaway: str


def narration_facts(case: dict, txs: list[dict], accounts: dict) -> dict:
    ordered = _ordered(txs)
    steps, prev = [], None
    for i, t in enumerate(ordered, 1):
        age = _age_days(accounts, t["destination_account"], t["timestamp"])
        steps.append({
            "step": i, "transaction_id": t["transaction_id"], "from": _name(accounts, t["source_account"]),
            "to": _name(accounts, t["destination_account"]), "amount_text": inr(t["amount"]),
            "time_utc": t["timestamp"][11:16], "date": t["timestamp"][:10], "channel": t["channel"],
            "minutes_after_previous": _minutes(prev["timestamp"], t["timestamp"]) if prev else None,
            "signals": [s["label"] for s in t.get("signals", [])],
            "recipient_account_age_days": age,
            "recipient_kyc": {"MIN_KYC": "minimum KYC", "FULL_KYC": "full KYC"}.get(
                (accounts.get(t["destination_account"]) or {}).get("kyc_tier") or "", None),
        })
        prev = t
    return {"case_id": case["case_id"], "risk_score": case["risk_score"], "risk_band": case["risk_band"],
            "steps": steps, "span_minutes": _minutes(ordered[0]["timestamp"], ordered[-1]["timestamp"]) if ordered else 0}


def _rules_caption(s: dict) -> str:
    text = f"{s['from']} paid {s['to']} {s['amount_text']}"
    if s["minutes_after_previous"] is not None:
        text += f", {s['minutes_after_previous']} min after the previous transfer"
    if s["recipient_account_age_days"] is not None and 0 <= s["recipient_account_age_days"] <= 30:
        text += f"; the recipient's account was {s['recipient_account_age_days']} days old"
    risk = [lbl for lbl in s["signals"] if lbl not in (LABELS["RELATIONSHIP_NOVELTY"], LABELS["SHARED_DEVICE"])]
    if risk:
        text += f" ({', '.join(risk).lower()})"
    return text + "."


def _rules_narration(f: dict) -> dict:
    steps = f["steps"]
    senders = {s["from"] for s in steps}
    receivers = {s["to"] for s in steps}
    origins = [s["from"] for s in steps if s["from"] not in receivers]
    ends = sorted(receivers - senders)
    overview = (f"{len(steps)} transfer{'s' if len(steps) != 1 else ''} over {f['span_minutes']} minutes"
                + (f", starting from {origins[0]}" if origins else "")
                + (f" and ending with {', '.join(ends[:2])}{' and others' if len(ends) > 2 else ''}" if ends else "") + ".")
    counts: dict[str, int] = {}
    for s in steps:
        for lbl in s["signals"]:
            counts[lbl] = counts.get(lbl, 0) + 1
    top = max(counts, key=counts.get) if counts else None
    takeaway = f"The most frequent signal along the flow is {top.lower()} ({counts[top]} of {len(steps)} transfers)." if top \
        else "No rule signal fired along this flow."
    return {"overview": overview, "takeaway": takeaway,
            "steps": [{"step": s["step"], "transaction_id": s["transaction_id"], "caption": _rules_caption(s)} for s in steps]}


def narrate(case: dict, txs: list[dict], accounts: dict) -> dict:
    f = narration_facts(case, txs, accounts)
    task = ("Narrate this money flow for an analyst replaying it step by step on a graph. Write one caption (max 25 words) "
            "per transaction_id, in step order, saying what happened and why it matters (timing, onward movement, new "
            "accounts, signals). Add a one-sentence overview and a one-sentence takeaway. Use holder names as given.")
    parsed, reason, detail = ai_common.ask(ai_common.INSIGHTS_SYSTEM_PROMPT, facts_prompt(task, f), Narration)
    if parsed is None:
        return from_rules(_rules_narration(f), reason, detail)
    ids = Ids({s["transaction_id"] for s in f["steps"]}, (TX_ID_PATTERN,))
    given: dict[str, str] = {}
    for s in parsed.steps:
        if ids.ok(s.transaction_id) and s.transaction_id not in given:
            given[s.transaction_id] = ids.scrub(s.caption, 220)
    fallback = {s["transaction_id"]: _rules_caption(s) for s in f["steps"]}
    steps = [{"step": s["step"], "transaction_id": s["transaction_id"],
              "caption": given.get(s["transaction_id"], fallback[s["transaction_id"]])} for s in f["steps"]]
    return from_gemini({"overview": ids.scrub(parsed.overview, 300), "takeaway": ids.scrub(parsed.takeaway, 300),
                        "steps": steps}, ids.report(captions_filled_by_rules=len(steps) - len(given)))


# ---- 2. Counterfactual: what the score rests on ----

class CounterPoint(BaseModel):
    text: str
    transaction_ids: list[str]


class CounterfactualNote(BaseModel):
    summary: str
    points: list[CounterPoint]


def counterfactual_facts(case: dict, txs: list[dict], accounts: dict, all_rows: list[dict], window: int) -> dict:
    ordered = _ordered(txs)
    case_ids = [t["transaction_id"] for t in ordered]
    current = max((t.get("score") or 0) for t in ordered) if ordered else 0
    removals = []
    parsed_rows = [risk_engine.Tx.from_row(r) for r in all_rows]
    for i, t in enumerate(ordered, 1):
        ctx = risk_engine.RiskContext([x for x in parsed_rows if x.id != t["transaction_id"]])
        others = set(case_ids) - {t["transaction_id"]}
        rest = [x for x in ctx.txs if x.id in others]
        scores = [risk_engine.assess(x, ctx, window)["score"] for x in rest]
        new = max(scores) if scores else 0
        removals.append({"step": i, "transaction_id": t["transaction_id"], "from": _name(accounts, t["source_account"]),
                         "to": _name(accounts, t["destination_account"]), "amount_text": inr(t["amount"]),
                         "score_without": new, "band_without": risk_band(new), "change": new - current,
                         "transfers_still_flagged": sum(1 for s in scores if s >= CASE_MIN_SCORE),
                         "would_leave_queue": new < CASE_MIN_SCORE})
    signals = []
    for code in sorted({s["code"] for t in ordered for s in t.get("signals", [])}):
        per_tx = [min(100, risk_engine.round_half_up(sum(s["contribution"] for s in t.get("signals", []) if s["code"] != code)))
                  for t in ordered]
        new = max(per_tx) if per_tx else 0
        signals.append({"code": code, "label": LABELS.get(code, code), "context_only": code in risk_engine.CONTEXT_ONLY,
                        "score_without": new, "band_without": risk_band(new), "change": new - current})
    removals.sort(key=lambda r: (r["change"], r["step"]))
    signals.sort(key=lambda s: (s["change"], s["code"]))
    return {"case_id": case["case_id"], "current_score": current, "current_band": risk_band(current),
            "queue_threshold": CASE_MIN_SCORE, "high_threshold": risk_engine.BAND_THRESHOLDS["HIGH"],
            "remove_one_transfer": removals, "turn_off_one_rule": signals}


def _rules_counterfactual(f: dict) -> dict:
    points = []
    key_tx = f["remove_one_transfer"][0] if f["remove_one_transfer"] else None
    key_sig = f["turn_off_one_rule"][0] if f["turn_off_one_rule"] else None
    if key_tx and key_tx["change"] < 0:
        points.append({"text": f"Without step {key_tx['step']} ({key_tx['from']} to {key_tx['to']}, {key_tx['amount_text']}) "
                               f"the case would score {key_tx['score_without']} ({key_tx['band_without'].lower()})"
                               + ("; it would leave the review queue." if key_tx["would_leave_queue"] else "."),
                       "transaction_ids": [key_tx["transaction_id"]]})
    robust = [r for r in f["remove_one_transfer"] if r["change"] == 0]
    if robust and len(robust) == len(f["remove_one_transfer"]):
        points.append({"text": "No single transfer drives the score: removing any one leaves it unchanged, so the pattern "
                               "is spread across the flow.", "transaction_ids": []})
    if key_sig and key_sig["change"] < 0:
        points.append({"text": f"Turning off {key_sig['label'].lower()} alone would lower the score to "
                               f"{key_sig['score_without']} ({key_sig['band_without'].lower()}).", "transaction_ids": []})
    context = [s for s in f["turn_off_one_rule"] if s["context_only"] and s["change"] == 0]
    if context:
        points.append({"text": "Context-only signals (" + ", ".join(s["label"].lower() for s in context) +
                               ") do not change the priority on their own.", "transaction_ids": []})
    summary = f"The case scores {f['current_score']} ({f['current_band'].lower()})."
    if key_tx and key_tx["change"] < 0:
        summary += f" It rests most on step {key_tx['step']}, whose removal changes the score by {key_tx['change']}."
    return {"summary": summary, "points": points, "facts": f}


def counterfactual(case: dict, txs: list[dict], accounts: dict, all_rows: list[dict], window: int) -> dict:
    f = counterfactual_facts(case, txs, accounts, all_rows, window)
    task = ("Explain to an analyst what this case's priority score rests on, using the counterfactual results: which "
            "single transfer or rule matters most, whether the pattern is robust or hinges on one transfer, and what "
            "that means for review. A one-sentence summary and up to 4 points, each citing the transaction_ids it is "
            "about (or none). Scores are priority indexes, not probabilities.")
    parsed, reason, detail = ai_common.ask(ai_common.INSIGHTS_SYSTEM_PROMPT, facts_prompt(task, f), CounterfactualNote)
    if parsed is None:
        return from_rules(_rules_counterfactual(f), reason, detail)
    ids = Ids({r["transaction_id"] for r in f["remove_one_transfer"]}, (TX_ID_PATTERN,))
    return from_gemini({"summary": ids.scrub(parsed.summary, 400),
                        "points": [{"text": ids.scrub(p.text, 300), "transaction_ids": ids.keep(p.transaction_ids)}
                                   for p in parsed.points[:4]], "facts": f}, ids.report())


# ---- 3. Customer contact script ----

class ContactScript(BaseModel):
    opening: str
    verification_questions: list[str]
    if_confirmed: str
    if_not_recognised: str
    closing: str
    sms_text: str


CONTACT_SYSTEM_PROMPT = """You draft wording for a bank's customer contact agent who will confirm recent transfers with an account holder. The bank calls the number on record (a verified channel). All data is synthetic.
Rules you must follow:
1. Never ask for, or mention collecting, an OTP, PIN, CVV, password, full card number or login details. Never ask the customer to install an app, share a screen, click a link or move money.
2. Do not say or imply that the customer or the activity is suspected, under investigation, fraudulent or suspicious. Do not mention money laundering, mules, police or other customers' accounts. Present the call as a routine confirmation of recent activity.
3. Mention only the transfers listed in FACTS, with the amounts, dates and payee names given there.
4. Polite, short, plain sentences. Write every field in the requested LANGUAGE (use its native script).
5. The agent decides what to do; you only provide wording. Nothing is sent automatically.
Return only JSON matching the schema."""

_SECRETS = re.compile(r"\b(otp|one[- ]time (?:password|code)|pin|cvv|password|passcode|card number|login|log in|"
                      r"anydesk|teamviewer|screen ?share|remote access|install|click|link|https?://|www\.)\b|"
                      r"ओटीपी|पिन|पासवर्ड|ઓટીપી|પિન|પાસવર્ડ", re.IGNORECASE)
_SAFETY_REMINDER = re.compile(r"\b(never|do not|don't|will not|won't)\b.{0,40}\b(share|ask|give|tell)\b|"
                              r"कभी|साझा न|ક્યારેય", re.IGNORECASE)
_TIPOFF = re.compile(r"\b(fraud(?!graph)\w*|suspicio\w*|suspect\w*|investigat\w*|launder\w*|mules?|police|criminal|illegal|"
                     r"scam\w*|flagged)\b|धोखाधड़ी|संदिग्ध|जांच|छेतरपिंडी|શંકાસ્પદ|છેતરપિંડી|તપાસ", re.IGNORECASE)
_SENTENCE = re.compile(r"(?<=[.!?।])\s+")

COMPLIANCE_NOTES = [
    "Call only the number on record. Never use a number supplied in a message or by a third party.",
    "Never ask for an OTP, PIN, CVV or password, and never ask the customer to move money.",
    "Do not mention a review, suspicion or any other account (tipping-off). Treat it as a routine confirmation.",
    "Record what the customer said on the verification task before closing it.",
]


def _safe(text: str, removed: list[str], limit: int = 500) -> str:
    kept = []
    for sentence in _SENTENCE.split(trunc(text, limit)):
        if _TIPOFF.search(sentence) or (_SECRETS.search(sentence) and not _SAFETY_REMINDER.search(sentence)):
            removed.append(sentence)
            continue
        kept.append(sentence)
    return " ".join(kept).strip()


def contact_facts(case: dict, txs: list[dict], accounts: dict, account_id: str, channel: str, language: str) -> dict:
    own = [t for t in _ordered(txs) if account_id in (t["source_account"], t["destination_account"])][:6]
    acc = accounts.get(account_id) or {}
    return {
        "language": LANGUAGES[language], "channel": channel, "bank_name": "FG Bank",
        "customer": {"name": acc.get("holder_name") or "the customer", "account_type": acc.get("account_type"),
                     "account_last4": (acc.get("account_number") or "")[-4:] or None},
        "transfers_to_confirm": [{
            "direction": "sent" if t["source_account"] == account_id else "received",
            "counterparty": _name(accounts, t["destination_account"] if t["source_account"] == account_id else t["source_account"]),
            "amount_text": inr(t["amount"]), "date": t["timestamp"][:10], "time_utc": t["timestamp"][11:16],
            "channel": t["channel"]} for t in own],
    }


def _rules_contact(f: dict) -> dict:
    c = f["customer"]
    first = (c["name"] or "").split()[0] if c["name"] else ""
    tx = f["transfers_to_confirm"]
    questions = [f"Did you {('send' if t['direction'] == 'sent' else 'expect to receive')} {t['amount_text']} "
                 f"{'to' if t['direction'] == 'sent' else 'from'} {t['counterparty']} on {t['date']} via {t['channel']}?"
                 for t in tx[:4]]
    questions.append("What was the purpose of these payments?")
    if any(t["direction"] == "received" for t in tx):
        questions.append("Do you know the people or businesses who sent you money, and did you expect it?")
    ending = f" on the account ending {c['account_last4']}" if c["account_last4"] else ""
    return {
        "opening": f"Hello {first}, this is the customer care team at {f['bank_name']}. We are calling to confirm some "
                   f"recent transfers{ending}. This will take about two minutes.",
        "verification_questions": questions,
        "if_confirmed": "Thank you for confirming. No further action is needed from you. If we need any document, we will "
                        "write to you through your registered email address.",
        "if_not_recognised": "Thank you for telling us. We will place a temporary hold on further transfers while our team "
                             "looks into it, and we will contact you again within one working day. Please do not share "
                             "your OTP or PIN with anyone.",
        "closing": "Thank you for your time. If you have any questions, please call the number printed on your card or "
                   "passbook.",
        "sms_text": f"{f['bank_name']}: Please call us back on the number printed on your card to confirm recent transfers"
                    f"{ending}. We will never ask for your OTP or PIN.",
    }


def contact_script(case: dict, txs: list[dict], accounts: dict, account_id: str, channel: str, language: str) -> dict:
    f = contact_facts(case, txs, accounts, account_id, channel, language)
    task = (f"Draft a {channel.lower()} script in {LANGUAGES[language]} for confirming the listed transfers with the "
            f"customer: an opening, 3-5 verification questions, what to say if they confirm, what to say if they do not "
            f"recognise the transfers, a closing, and a short SMS (max 160 characters) asking them to call back.")
    parsed, reason, detail = ai_common.ask(CONTACT_SYSTEM_PROMPT, facts_prompt(task, f), ContactScript)
    if parsed is None:
        script = _rules_contact(f)
        result = {**script, "language": "en", "requested_language": language, "compliance_notes": COMPLIANCE_NOTES,
                  "account_id": account_id, "channel": channel, "facts": f}
        return from_rules(result, reason, detail)
    removed: list[str] = []
    script = {
        "opening": _safe(parsed.opening, removed),
        "verification_questions": [q for q in (_safe(q, removed, 240) for q in parsed.verification_questions[:6]) if q],
        "if_confirmed": _safe(parsed.if_confirmed, removed),
        "if_not_recognised": _safe(parsed.if_not_recognised, removed),
        "closing": _safe(parsed.closing, removed),
        "sms_text": _safe(parsed.sms_text, removed, 300),
    }
    fallback = _rules_contact(f) if language == "en" else {}
    for key, value in script.items():  # an English template line replaces a field that was filtered out entirely
        if not value and key in fallback:
            script[key] = fallback[key]
    result = {**script, "language": language, "requested_language": language, "compliance_notes": COMPLIANCE_NOTES,
              "account_id": account_id, "channel": channel, "facts": f}
    return from_gemini(result, {"removed_ids": [], "removed_sentences": removed})


# ---- 4. STR-style regulatory draft ----

RED_FLAGS = {
    "RAPID_MOVEMENT_OF_FUNDS": "Funds moved onward rapidly after receipt",
    "PASS_THROUGH_ACCOUNT": "Account used to pass funds through to others",
    "FAN_IN_CONSOLIDATION": "Many senders paying into one account, followed by an outbound transfer",
    "UNUSUAL_FOR_PROFILE": "Amount unusual for the customer's normal activity",
    "HIGH_VELOCITY": "Many transfers in a short period",
    "NEW_ACCOUNT_HIGH_VALUE": "High-value activity soon after account opening",
    "SHARED_DEVICE": "Several accounts operated from one device",
    "MIN_KYC_HIGH_VALUE": "Minimum-KYC account with high-value activity",
}
RedFlag = Literal["RAPID_MOVEMENT_OF_FUNDS", "PASS_THROUGH_ACCOUNT", "FAN_IN_CONSOLIDATION", "UNUSUAL_FOR_PROFILE",
                  "HIGH_VELOCITY", "NEW_ACCOUNT_HIGH_VALUE", "SHARED_DEVICE", "MIN_KYC_HIGH_VALUE"]
SIGNAL_FLAGS = {"RAPID_ONWARD": "RAPID_MOVEMENT_OF_FUNDS", "FAN_IN_RAPID_OUT": "FAN_IN_CONSOLIDATION",
                "UNUSUAL_AMOUNT": "UNUSUAL_FOR_PROFILE", "VELOCITY": "HIGH_VELOCITY", "SHARED_DEVICE": "SHARED_DEVICE"}


class Ground(BaseModel):
    text: str
    evidence_ids: list[str]


class STRNarrative(BaseModel):
    summary_of_suspicion: str
    grounds: list[Ground]
    red_flags: list[RedFlag]
    sequence_of_events: list[Ground]
    information_gaps: list[str]


def str_record_parts(case: dict, txs: list[dict], accounts: dict, actions: list[dict], decisions: list[dict]) -> dict:
    """Fields filled from records, never by the model."""
    ordered = _ordered(txs)
    first = ordered[0]["timestamp"] if ordered else None
    subjects = []
    for acc_id in case["accounts"]:
        a = accounts.get(acc_id) or {}
        subjects.append({"account_id": acc_id, "holder_name": a.get("holder_name"), "account_number": a.get("account_number"),
                         "account_type": a.get("account_type"), "kyc_tier": a.get("kyc_tier"), "city": a.get("city"),
                         "opened": a.get("created_at"),
                         "sent": round(sum(t["amount"] for t in ordered if t["source_account"] == acc_id), 2),
                         "received": round(sum(t["amount"] for t in ordered if t["destination_account"] == acc_id), 2)})
    return {
        "report_reference": f"DRAFT-STR-{case['case_id']}",
        "reporting_entity": "FraudGraph Bank (sandbox)",
        "period": {"from": first, "to": ordered[-1]["timestamp"] if ordered else None},
        "total_amount": round(sum(t["amount"] for t in ordered), 2),
        "subjects": subjects,
        "transactions": [{"transaction_id": t["transaction_id"], "timestamp": t["timestamp"],
                          "from": t["source_account"], "to": t["destination_account"], "amount": t["amount"],
                          "currency": t["currency"], "channel": t["channel"], "reference": t.get("reference"),
                          "score": t.get("score")} for t in ordered],
        "actions_taken": [{"label": a["label"], "target_account": a["target_account"], "status": a["status"],
                           "approved_by": a["actor_label"], "approved_at": a["created_at"]} for a in actions],
        "analyst_decision": ({"decision": decisions[-1]["decision"], "rationale": decisions[-1]["rationale"],
                              "by": decisions[-1]["actor_label"], "at": decisions[-1]["created_at"]} if decisions else None),
    }


def _rules_str(case: dict, txs: list[dict], accounts: dict, evidence: list[dict]) -> dict:
    ev_ids = {e["evidence_id"] for e in evidence}
    grounds, flags = [], []
    for code in case["signal_codes"]:
        if code in risk_engine.CONTEXT_ONLY and code != "SHARED_DEVICE":
            continue
        hits = [t for t in txs if any(s["code"] == code for s in t.get("signals", []))]
        cites = [f"EV-SIG-{t['transaction_id']}-{code}" for t in hits if f"EV-SIG-{t['transaction_id']}-{code}" in ev_ids][:4]
        if hits:
            example = next((s["explanation"] for s in hits[0]["signals"] if s["code"] == code), "")
            grounds.append({"text": f"{LABELS.get(code, code)} on {len(hits)} transfer(s). {example}", "evidence_ids": cites})
        if code in SIGNAL_FLAGS:
            flags.append(SIGNAL_FLAGS[code])
    ordered = _ordered(txs)
    for t in ordered:
        age = _age_days(accounts, t["destination_account"], t["timestamp"])
        if age is not None and 0 <= age <= 30 and t["amount"] >= 100_000 and "NEW_ACCOUNT_HIGH_VALUE" not in flags:
            flags.append("NEW_ACCOUNT_HIGH_VALUE")
        if (accounts.get(t["destination_account"]) or {}).get("kyc_tier") == "MIN_KYC" and t["amount"] >= 50_000 \
                and "MIN_KYC_HIGH_VALUE" not in flags:
            flags.append("MIN_KYC_HIGH_VALUE")
    relays = {t["destination_account"] for t in ordered} & {t["source_account"] for t in ordered}
    if relays:
        flags.append("PASS_THROUGH_ACCOUNT")
    sequence = [{"text": f"{t['timestamp'][:16].replace('T', ' ')} {_name(accounts, t['source_account'])} paid "
                         f"{_name(accounts, t['destination_account'])} {inr(t['amount'])} via {t['channel']}.",
                 "evidence_ids": [f"EV-TX-{t['transaction_id']}"] if f"EV-TX-{t['transaction_id']}" in ev_ids else []}
                for t in ordered[:10]]
    summary = (f"Between {ordered[0]['timestamp'][:10]} and {ordered[-1]['timestamp'][:10]}, {len(ordered)} transfers totalling "
               f"{inr(sum(t['amount'] for t in ordered))} moved between {len(case['accounts'])} accounts in a pattern "
               f"consistent with {', '.join(LABELS.get(c, c).lower() for c in case['signal_codes'][:2])}. The case was "
               f"prioritised {case['risk_band'].lower()} (score {case['risk_score']}) by the rule engine.") if ordered else ""
    uncertainties = sorted({u for t in txs for u in t.get("uncertainties", [])})[:3]
    return {"summary_of_suspicion": summary, "grounds": grounds, "red_flags": sorted(set(flags), key=list(RED_FLAGS).index),
            "sequence_of_events": sequence, "information_gaps": uncertainties}


def str_draft(case: dict, txs: list[dict], accounts: dict, evidence: list[dict], actions: list[dict],
              decisions: list[dict]) -> dict:
    parts = str_record_parts(case, txs, accounts, actions, decisions)
    labels = {"red_flag_labels": RED_FLAGS, "draft_note": "Draft for the compliance officer. Not filed with any authority."}
    items, allowed = gemini_service.build_package(case, evidence)
    task = ("Draft the narrative sections of a suspicious transaction report (STR) for the compliance officer, using "
            "the required JSON schema: a summary of the grounds of suspicion (neutral, factual, 3-5 sentences); the "
            "grounds, each citing evidence_ids; red flags chosen only from the allowed codes; the sequence of events in "
            "time order, each citing evidence_ids; and information gaps the officer should close before filing. Refer to "
            "accounts by account ID. Describe a pattern 'consistent with' a typology; never conclude that anyone "
            "committed an offence.\nRED_FLAG_CODES (JSON): " + json.dumps(RED_FLAGS))
    parsed, reason, detail = ai_common.ask(gemini_service.SYSTEM_PROMPT, gemini_service._prompt(case, items, task, None),
                                           STRNarrative)
    if parsed is None:
        return from_rules({**parts, **_rules_str(case, txs, accounts, evidence), **labels}, reason, detail)
    cit = gemini_service._Citations(allowed)
    unsupported = []

    def grounded(rows: list[Ground], section: str) -> list[dict]:
        out = []
        for g in rows[:12]:
            ids, text = cit.ids(g.evidence_ids), cit.scrub(g.text)
            if ids:
                out.append({"text": text, "evidence_ids": ids})
            else:
                unsupported.append({"section": section, "text": text})
        return out

    narrative = {
        "summary_of_suspicion": cit.scrub(parsed.summary_of_suspicion),
        "grounds": grounded(parsed.grounds, "grounds"),
        "red_flags": sorted(set(parsed.red_flags), key=list(RED_FLAGS).index),
        "sequence_of_events": grounded(parsed.sequence_of_events, "sequence_of_events"),
        "information_gaps": [cit.scrub(t) for t in parsed.information_gaps[:8]],
    }
    return from_gemini({**parts, **narrative, **labels}, cit.report(unsupported))


# ---- 5. Translated summary ----

class Translation(BaseModel):
    summary: str
    key_points: list[str]
    next_steps: list[str]


TRANSLATE_SYSTEM_PROMPT = """You translate a fraud investigation summary for a bank analyst. All data is synthetic.
Translate faithfully into the requested language using its native script. Do not add, remove or soften facts. Keep account IDs, transfer IDs, evidence IDs (EV-...), amounts and dates exactly as written. Keep neutral wording: never state that anyone committed fraud. Return only JSON matching the schema."""


def translate(investigation: dict, language: str, allowed: set[str]) -> dict:
    source = {"summary": investigation.get("case_summary", ""),
              "key_points": [f"{i['indicator']}: {i['reasoning']}" for i in investigation.get("risk_indicators", [])][:5],
              "next_steps": investigation.get("recommended_next_steps", [])[:5]}
    if language == "en":
        return from_rules({**source, "language": "en"})
    task = f"Translate SOURCE into {LANGUAGES[language]}. Keep the same number of key points and next steps."
    parsed, reason, detail = ai_common.ask(TRANSLATE_SYSTEM_PROMPT, facts_prompt(task, {"SOURCE": source}), Translation)
    if parsed is None:
        return unavailable(reason, detail)
    cit = gemini_service._Citations(allowed)
    return from_gemini({"summary": cit.scrub(parsed.summary), "key_points": [cit.scrub(t) for t in parsed.key_points[:6]],
                        "next_steps": [cit.scrub(t) for t in parsed.next_steps[:6]], "language": language},
                       {"removed_ids": sorted(set(cit.removed))})


def suggested_contact(case: dict, txs: list[dict], actions: list[dict]) -> str | None:
    """The account an open verification task points at, else the origin of the flow."""
    for a in actions:
        if a["action_code"] == "REQUEST_CUSTOMER_VERIFICATION" and a["status"] in mitigation.IN_EFFECT and a["target_account"]:
            return a["target_account"]
    ordered = _ordered(txs)
    return ordered[0]["source_account"] if ordered else None
