"""Red team: Gemini designs money-mule patterns meant to slip under the rules, and the real engine judges them.

Gemini only chooses bounded parameters (how many feeders, hops, gaps, amounts). Code turns them into synthetic
transfers, scores them with `risk_engine` next to the live history, and for every pattern that evades it searches
for the smallest single rule change that would catch it, measuring how many extra alerts that change would add on
the existing history. Nothing is written to the transaction tables and no rule is changed: rules move only through
a reviewed rule-version release.
"""
import sqlite3
from datetime import timedelta

from pydantic import BaseModel

from backend.services import ai_common, risk_engine
from backend.services.ai_common import facts_prompt, from_gemini, from_rules, inr, trunc
from backend.services.analysis import load_transactions
from backend.services.risk_engine import CASE_MIN_SCORE, LABELS

# Bounds Gemini must respect. Values are clamped in code too, so the schema is never trusted.
BOUNDS = {
    "feeders": (1, 8, "Accounts paying into the collecting (mule) account"),
    "layers": (1, 4, "Hops the money takes after the mule account"),
    "split": (1, 5, "Accounts the mule splits the money across at the first hop"),
    "amount_each": (5_000, 500_000, "Rupees per feeder payment"),
    "feeder_gap_minutes": (1, 240, "Minutes between feeder payments"),
    "hop_gap_minutes": (1, 1440, "Minutes each account waits before moving the money on"),
    "onward_share": (0.3, 1.0, "Share of the money moved on at each hop"),
}
MAX_ATTACKS = 3

# Single changes tried, smallest first, when a pattern evades. Each is simulated, never applied.
CANDIDATE_FIXES = [
    ("ONWARD_WINDOW_MINUTES", 60, "Rapid onward movement window", "minutes", 30),
    ("ONWARD_WINDOW_MINUTES", 120, "Rapid onward movement window", "minutes", 30),
    ("FAN_IN_MIN_COUNT", 3, "Many-in / rapid-out inbound count", "transfers", risk_engine.FAN_IN_MIN_COUNT),
    ("VELOCITY_MIN_COUNT", 3, "Transfer velocity count", "transfers", risk_engine.VELOCITY_MIN_COUNT),
    ("ONWARD_PARTIAL_RATIO", 0.3, "Onward share for half weight", "share", risk_engine.ONWARD_PARTIAL_RATIO),
    ("window_minutes", 180, "Linking window", "minutes", risk_engine.DEFAULT_WINDOW_MINUTES),
    ("ONWARD_WINDOW_MINUTES", 360, "Rapid onward movement window", "minutes", 30),
    ("ONWARD_WINDOW_MINUTES", 1440, "Rapid onward movement window", "minutes", 30),
]


class Attack(BaseModel):
    name: str
    idea: str
    feeders: int
    layers: int
    split: int
    amount_each: float
    feeder_gap_minutes: int
    hop_gap_minutes: int
    onward_share: float


class AttackPlan(BaseModel):
    summary: str
    attacks: list[Attack]


SYSTEM_PROMPT = """You are the red team for FraudGraph AI, a fraud-detection workspace that runs only on synthetic, fictional data.
Your job is to help the defenders: design money-mule transfer patterns that would score low on the rules described in FACTS, so the team can see blind spots before criminals find them.
Rules you must follow:
1. Describe patterns only through the numeric parameters in FACTS.bounds, within their min and max.
2. Each pattern must still move a meaningful amount of money through several accounts; a pattern that moves almost nothing is not useful.
3. Make the patterns genuinely different from each other (for example: slow layering, small structured payments, wide splitting).
4. name: at most 5 words. idea: one sentence on which rule weakness it targets. No operational advice beyond the parameters.
5. Return only JSON matching the requested schema."""


def _clamp(attack: dict) -> dict:
    out = {"name": trunc(attack.get("name") or "Pattern", 60), "idea": trunc(attack.get("idea") or "", 240)}
    for key, (lo, hi, _) in BOUNDS.items():
        value = min(hi, max(lo, float(attack.get(key, lo))))
        out[key] = round(value, 2) if key == "onward_share" else int(round(value))
    return out


RULE_ATTACKS = [
    {"name": "Slow layering", "idea": "Waits longer than the 30-minute onward window at every hop.",
     "feeders": 4, "layers": 3, "split": 2, "amount_each": 60_000, "feeder_gap_minutes": 20,
     "hop_gap_minutes": 95, "onward_share": 0.95},
    {"name": "Few small feeders", "idea": "Stays under the fan-in count and the no-baseline amount threshold.",
     "feeders": 3, "layers": 2, "split": 1, "amount_each": 30_000, "feeder_gap_minutes": 30,
     "hop_gap_minutes": 45, "onward_share": 0.9},
    {"name": "Fast pass-through", "idea": "A control pattern: money moves on within minutes, which the rules should catch.",
     "feeders": 5, "layers": 2, "split": 3, "amount_each": 80_000, "feeder_gap_minutes": 5,
     "hop_gap_minutes": 8, "onward_share": 0.95},
]


def build_transfers(attack: dict, start, index: int) -> list[dict]:
    """Turn bounded parameters into synthetic transfer rows (never stored)."""
    prefix = f"RT{index}"
    rows: list[dict] = []
    t = start

    def add(src: str, dst: str, amount: float, ts, device: str | None) -> None:
        rows.append({"transaction_id": f"TX-{prefix}{len(rows) + 1:03d}", "source_account": src,
                     "destination_account": dst, "amount": round(amount, 2), "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%S"),
                     "device_id": device, "channel": "IMPS"})

    mule = f"{prefix}-M"
    for i in range(attack["feeders"]):
        add(f"{prefix}-F{i + 1}", mule, attack["amount_each"], t, f"DEV-{prefix}-F{i + 1}")
        t += timedelta(minutes=attack["feeder_gap_minutes"])
    held = {mule: attack["feeders"] * attack["amount_each"]}
    t += timedelta(minutes=attack["hop_gap_minutes"] - attack["feeder_gap_minutes"])
    for layer in range(1, attack["layers"] + 1):
        width = attack["split"] if layer == 1 else 1
        nxt: dict[str, float] = {}
        for k, (acct, amount) in enumerate(held.items()):
            for j in range(width):
                dst = f"{prefix}-L{layer}-{k + 1}{j + 1}" if layer < attack["layers"] else f"{prefix}-OUT"
                share = amount * attack["onward_share"] / width
                add(acct, dst, share, t + timedelta(minutes=j), f"DEV-{acct}")
                nxt[dst] = nxt.get(dst, 0) + share
        held = nxt
        t += timedelta(minutes=attack["hop_gap_minutes"])
    return rows


def _score(history: list[dict], extra: list[dict], window: int, overrides: dict) -> dict[str, dict]:
    o = dict(overrides)
    window = int(o.pop("window_minutes", window))
    return risk_engine.assess_all(history + extra, window, o)


def _result(rows: list[dict], scores: dict[str, dict]) -> dict:
    mine = [scores[r["transaction_id"]] for r in rows]
    top = max(mine, key=lambda a: a["score"])
    fired = sorted({s["code"] for a in mine for s in a["signals"]})
    return {"max_score": top["score"], "band": risk_engine.risk_band(top["score"]),
            "caught": top["score"] >= CASE_MIN_SCORE, "flagged": sum(1 for a in mine if a["score"] >= CASE_MIN_SCORE),
            "signals": [{"code": c, "label": LABELS[c]} for c in fired]}


def run(conn: sqlite3.Connection, use_ai: bool) -> dict:
    history = load_transactions(conn)
    window = risk_engine.DEFAULT_WINDOW_MINUTES
    labels = {r["transaction_id"]: r["label"] for r in conn.execute("SELECT transaction_id, label FROM labels")}
    start = max(risk_engine.parse_ts(r["timestamp"]) for r in history) + timedelta(days=1)

    reason = detail = None
    plan = None
    if use_ai:
        facts = {"rules": risk_engine.rules_description(), "time_window_minutes": window,
                 "case_threshold_score": CASE_MIN_SCORE,
                 "bounds": {k: {"min": lo, "max": hi, "meaning": m} for k, (lo, hi, m) in BOUNDS.items()}}
        task = (f"Design {MAX_ATTACKS} different money-mule patterns that try to stay below a score of "
                f"{CASE_MIN_SCORE} on these rules. The system will build and score them; you only pick the parameters.")
        parsed, reason, detail = ai_common.ask(SYSTEM_PROMPT, facts_prompt(task, facts), AttackPlan)
        if parsed is not None and parsed.attacks:
            plan = {"summary": trunc(parsed.summary, 300), "attacks": [_clamp(a.model_dump()) for a in parsed.attacks[:MAX_ATTACKS]]}
    rules = plan is None
    plan = plan or {"summary": "Three standard evasion patterns from the team's playbook.",
                    "attacks": [_clamp(a) for a in RULE_ATTACKS]}

    base_hist = risk_engine.assess_all(history, window)
    base_flag = {t for t, a in base_hist.items() if a["score"] >= CASE_MIN_SCORE}
    cost_cache: dict[tuple, dict] = {}

    def cost(param: str, value) -> dict:
        key = (param, value)
        if key not in cost_cache:
            after = _score(history, [], window, {param: value})
            flagged = {t for t, a in after.items() if a["score"] >= CASE_MIN_SCORE}
            new = flagged - base_flag
            cost_cache[key] = {"new_alerts": len(new),
                               "new_alerts_on_suspicious": sum(1 for t in new if labels.get(t) == "SUSPICIOUS")}
        return cost_cache[key]

    attacks = []
    for i, attack in enumerate(plan["attacks"], start=1):
        rows = build_transfers(attack, start + timedelta(days=i), i)
        res = _result(rows, _score(history, rows, window, {}))
        fix = None
        if not res["caught"]:
            for param, value, label, unit, current in CANDIDATE_FIXES:
                trial = _result(rows, _score(history, rows, window, {param: value}))
                if trial["caught"]:
                    fix = {"parameter": param, "label": label, "current_value": current, "proposed_value": value,
                           "unit": unit, "score_after": trial["max_score"], "band_after": trial["band"],
                           **cost(param, value)}
                    break
        span = risk_engine.parse_ts(rows[-1]["timestamp"]) - risk_engine.parse_ts(rows[0]["timestamp"])
        accounts = {a for r in rows for a in (r["source_account"], r["destination_account"])}
        attacks.append({**attack, "transfers": len(rows), "accounts": len(accounts),
                        "amount_text": inr(attack["feeders"] * attack["amount_each"]),
                        "duration_minutes": int(span.total_seconds() // 60), **res, "fix": fix, "sample": rows[:12]})

    evaded = [a for a in attacks if not a["caught"]]
    result = {"summary": plan["summary"], "attacks": attacks, "evaded": len(evaded), "tested": len(attacks),
              "history_transfers": len(history), "case_threshold_score": CASE_MIN_SCORE,
              "note": "Simulated only. The patterns are never added to the data and no rule is changed."}
    return from_rules(result, reason, detail) if rules else from_gemini(result)
