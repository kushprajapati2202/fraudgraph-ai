"""Transparent, deterministic rule-based risk engine.

The score is a prioritization index (0-100), NOT a calibrated fraud probability.
score = min(100, round(sum(weight_i * value_i))) where each value_i is normalized to [0, 1].
"""
import bisect
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

RULE_VERSION = "rules-v1"

WEIGHTS = {
    "UNUSUAL_AMOUNT": 20,
    "VELOCITY": 15,
    "RAPID_ONWARD": 25,
    "FAN_IN_RAPID_OUT": 25,
    "RELATIONSHIP_NOVELTY": 5,
    "SHARED_DEVICE": 10,
}
LABELS = {
    "UNUSUAL_AMOUNT": "Unusual amount",
    "VELOCITY": "Transfer velocity",
    "RAPID_ONWARD": "Rapid onward movement",
    "FAN_IN_RAPID_OUT": "Many-in / rapid-out",
    "RELATIONSHIP_NOVELTY": "Relationship novelty",
    "SHARED_DEVICE": "Shared device",
}
CONTEXT_ONLY = {"RELATIONSHIP_NOVELTY", "SHARED_DEVICE"}

DEFAULT_WINDOW_MINUTES = 60
MIN_BASELINE_TXS = 3
UNUSUAL_RATIO_MIN = 3.0
UNUSUAL_RATIO_FULL = 10.0
HIGH_AMOUNT_NO_BASELINE = 100_000
VELOCITY_MIN_COUNT = 4
ONWARD_WINDOW_MINUTES = 30
ONWARD_FULL_RATIO = 0.7
ONWARD_PARTIAL_RATIO = 0.4
FAN_IN_MIN_COUNT = 4
FAN_IN_MIN_SENDERS = 3
SHARED_DEVICE_MIN_ACCOUNTS = 3

# Thresholds that rule-tuning suggestions may change in a simulation, with the bounds a suggestion must respect.
TUNABLE = {
    "UNUSUAL_RATIO_MIN": {"rule": "UNUSUAL_AMOUNT", "value": UNUSUAL_RATIO_MIN, "min": 2.0, "max": 6.0, "step": 0.5,
                          "meaning": "How many times the sender's usual (90th-percentile) amount a transfer must be"},
    "VELOCITY_MIN_COUNT": {"rule": "VELOCITY", "value": VELOCITY_MIN_COUNT, "min": 3, "max": 8, "step": 1,
                           "meaning": "Outgoing transfers within the window before velocity fires"},
    "ONWARD_PARTIAL_RATIO": {"rule": "RAPID_ONWARD", "value": ONWARD_PARTIAL_RATIO, "min": 0.3, "max": 0.7, "step": 0.05,
                             "meaning": "Share of an amount moved onward within 30 minutes for half weight"},
    "FAN_IN_MIN_COUNT": {"rule": "FAN_IN_RAPID_OUT", "value": FAN_IN_MIN_COUNT, "min": 3, "max": 8, "step": 1,
                         "meaning": "Inbound transfers before an outbound one for many-in / rapid-out"},
    "SHARED_DEVICE_MIN_ACCOUNTS": {"rule": "SHARED_DEVICE", "value": SHARED_DEVICE_MIN_ACCOUNTS, "min": 2, "max": 6,
                                   "step": 1, "meaning": "Accounts on one device before shared-device context fires"},
}

BAND_THRESHOLDS = {"LOW": 0, "MEDIUM": 30, "HIGH": 60}
CASE_MIN_SCORE = BAND_THRESHOLDS["MEDIUM"]


def risk_band(score: int) -> str:
    if score >= BAND_THRESHOLDS["HIGH"]:
        return "HIGH"
    if score >= BAND_THRESHOLDS["MEDIUM"]:
        return "MEDIUM"
    return "LOW"


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def fmt_amount(x: float) -> str:
    return f"{x:,.0f}"


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value)


@dataclass(frozen=True)
class Tx:
    id: str
    src: str
    dst: str
    amount: float
    ts: datetime
    device: str | None

    @staticmethod
    def from_row(row: dict) -> "Tx":
        return Tx(
            id=row["transaction_id"],
            src=row["source_account"],
            dst=row["destination_account"],
            amount=float(row["amount"]),
            ts=parse_ts(row["timestamp"]) if isinstance(row["timestamp"], str) else row["timestamp"],
            device=row.get("device_id") or None,
        )


class _Series:
    """Time-sorted transactions for one account, searchable by time range."""

    def __init__(self) -> None:
        self.ts: list[datetime] = []
        self.txs: list[Tx] = []

    def add(self, tx: Tx) -> None:
        self.ts.append(tx.ts)
        self.txs.append(tx)

    def between(self, lo: datetime, hi: datetime, lo_inclusive=True, hi_inclusive=True) -> list[Tx]:
        i = bisect.bisect_left(self.ts, lo) if lo_inclusive else bisect.bisect_right(self.ts, lo)
        j = bisect.bisect_right(self.ts, hi) if hi_inclusive else bisect.bisect_left(self.ts, hi)
        return self.txs[i:j]


class RiskContext:
    def __init__(self, transactions: list[Tx]):
        self.txs = sorted(transactions, key=lambda t: (t.ts, t.id))
        self.outgoing: dict[str, _Series] = defaultdict(_Series)
        self.incoming: dict[str, _Series] = defaultdict(_Series)
        self.device_accounts: dict[str, set[str]] = defaultdict(set)
        self.pair_first: dict[tuple[str, str], str] = {}
        for tx in self.txs:
            self.outgoing[tx.src].add(tx)
            self.incoming[tx.dst].add(tx)
            if tx.device:
                self.device_accounts[tx.device].add(tx.src)
            self.pair_first.setdefault((tx.src, tx.dst), tx.id)

    def baseline(self, account: str, before: datetime) -> dict:
        prior = [t.amount for t in self.outgoing[account].between(datetime.min, before, hi_inclusive=False)]
        if len(prior) < MIN_BASELINE_TXS:
            return {"account_id": account, "available": False, "prior_outgoing_count": len(prior)}
        ordered = sorted(prior)
        p90 = ordered[min(len(ordered) - 1, int(math.ceil(0.9 * len(ordered))) - 1)]
        return {
            "account_id": account,
            "available": True,
            "prior_outgoing_count": len(prior),
            "median_amount": round(statistics.median(ordered), 2),
            "p90_amount": round(p90, 2),
        }


def _signal(code: str, value: float, explanation: str, supporting: list[str], params: dict) -> dict:
    value = max(0.0, min(1.0, value))
    return {
        "code": code,
        "label": LABELS[code],
        "weight": WEIGHTS[code],
        "value": round(value, 3),
        "contribution": round(WEIGHTS[code] * value, 2),
        "explanation": explanation,
        "supporting_tx_ids": supporting,
        "params": params,
        "context_only": code in CONTEXT_ONLY,
    }


def _ratio_value(ratio: float, partial: float = ONWARD_PARTIAL_RATIO) -> float:
    if ratio >= ONWARD_FULL_RATIO:
        return 1.0
    if ratio >= partial:
        return 0.5
    return 0.0


def assess(tx: Tx, ctx: RiskContext, window_minutes: int = DEFAULT_WINDOW_MINUTES,
           overrides: dict | None = None) -> dict:
    """Score one transfer. `overrides` replaces TUNABLE thresholds (used only by rule-tuning simulations)."""
    p = {k: v["value"] for k, v in TUNABLE.items()} | (overrides or {})
    UNUSUAL_RATIO_MIN, VELOCITY_MIN_COUNT = p["UNUSUAL_RATIO_MIN"], p["VELOCITY_MIN_COUNT"]  # noqa: N806
    FAN_IN_MIN_COUNT, SHARED_DEVICE_MIN_ACCOUNTS = p["FAN_IN_MIN_COUNT"], p["SHARED_DEVICE_MIN_ACCOUNTS"]  # noqa: N806
    signals: list[dict] = []
    uncertainties: list[str] = []
    window = timedelta(minutes=window_minutes)
    # Simulation-only override (red team); never in TUNABLE, so rule tuning and live scoring keep 30 minutes.
    onward_minutes = p.get("ONWARD_WINDOW_MINUTES", ONWARD_WINDOW_MINUTES)
    onward = timedelta(minutes=onward_minutes)

    # UNUSUAL_AMOUNT
    base = ctx.baseline(tx.src, tx.ts)
    if base["available"]:
        ratio = tx.amount / base["p90_amount"] if base["p90_amount"] > 0 else 0.0
        if ratio >= UNUSUAL_RATIO_MIN:
            value = 0.5 + 0.5 * (ratio - UNUSUAL_RATIO_MIN) / (UNUSUAL_RATIO_FULL - UNUSUAL_RATIO_MIN)
            signals.append(_signal(
                "UNUSUAL_AMOUNT", value,
                f"Amount {fmt_amount(tx.amount)} is {ratio:.1f}x the source account's 90th-percentile "
                f"outgoing amount ({fmt_amount(base['p90_amount'])}, from {base['prior_outgoing_count']} prior payments).",
                [tx.id], {"ratio": round(ratio, 2), "ratio_min": UNUSUAL_RATIO_MIN, "ratio_full": UNUSUAL_RATIO_FULL},
            ))
    else:
        uncertainties.append(
            f"No baseline for {tx.src}: only {base['prior_outgoing_count']} prior outgoing payment(s) in the "
            f"available history (minimum {MIN_BASELINE_TXS}); amount unusualness cannot be judged reliably."
        )
        if tx.amount >= HIGH_AMOUNT_NO_BASELINE:
            signals.append(_signal(
                "UNUSUAL_AMOUNT", 0.5,
                f"Amount {fmt_amount(tx.amount)} is at or above {fmt_amount(HIGH_AMOUNT_NO_BASELINE)} and the "
                f"source account has no baseline (partial weight).",
                [tx.id], {"baseline_missing": True, "threshold": HIGH_AMOUNT_NO_BASELINE},
            ))

    # VELOCITY: source outgoing transfers within +/- window of this transfer
    burst = ctx.outgoing[tx.src].between(tx.ts - window, tx.ts + window)
    if len(burst) >= VELOCITY_MIN_COUNT:
        value = 0.5 + 0.25 * (len(burst) - VELOCITY_MIN_COUNT)
        signals.append(_signal(
            "VELOCITY", value,
            f"{tx.src} sent {len(burst)} transfers within {window_minutes} minutes of this transfer "
            f"(threshold {VELOCITY_MIN_COUNT}).",
            [t.id for t in burst], {"count": len(burst), "window_minutes": window_minutes, "min_count": VELOCITY_MIN_COUNT},
        ))

    # RAPID_ONWARD: (a) destination forwards funds soon after, or (b) this transfer forwards recently received funds
    if tx.amount > 0:
        after = [t for t in ctx.outgoing[tx.dst].between(tx.ts, tx.ts + onward, lo_inclusive=False) if t.id != tx.id]
        before = [t for t in ctx.incoming[tx.src].between(tx.ts - onward, tx.ts, hi_inclusive=False) if t.id != tx.id]
        ratio_a = sum(t.amount for t in after) / tx.amount
        ratio_b = sum(t.amount for t in before) / tx.amount
        value_a = _ratio_value(ratio_a, p["ONWARD_PARTIAL_RATIO"])
        value_b = _ratio_value(ratio_b, p["ONWARD_PARTIAL_RATIO"])
        if max(value_a, value_b) > 0:
            parts, supporting = [], [tx.id]
            if value_a > 0:
                parts.append(f"{tx.dst} sent onward {fmt_amount(sum(t.amount for t in after))} "
                             f"({ratio_a:.0%} of this amount) within {onward_minutes} minutes")
                supporting += [t.id for t in after]
            if value_b > 0:
                parts.append(f"{tx.src} had received {fmt_amount(sum(t.amount for t in before))} "
                             f"({ratio_b:.0%} of this amount) in the {onward_minutes} minutes before")
                supporting += [t.id for t in before]
            signals.append(_signal(
                "RAPID_ONWARD", max(value_a, value_b), "; ".join(parts) + ".",
                supporting,
                {"onward_window_minutes": onward_minutes, "ratio_after": round(ratio_a, 3),
                 "ratio_before": round(ratio_b, 3), "full_ratio": ONWARD_FULL_RATIO,
                 "partial_ratio": p["ONWARD_PARTIAL_RATIO"]},
            ))

    # FAN_IN_RAPID_OUT: many inbound transfers to the source shortly before this outbound transfer
    inbound = [t for t in ctx.incoming[tx.src].between(tx.ts - window, tx.ts, hi_inclusive=False) if t.id != tx.id]
    senders = {t.src for t in inbound}
    if len(inbound) >= FAN_IN_MIN_COUNT and len(senders) >= FAN_IN_MIN_SENDERS:
        value = (len(inbound) - FAN_IN_MIN_COUNT + 1) / 3
        signals.append(_signal(
            "FAN_IN_RAPID_OUT", value,
            f"{tx.src} received {len(inbound)} transfers from {len(senders)} different accounts within "
            f"{window_minutes} minutes before sending this transfer.",
            [t.id for t in inbound] + [tx.id],
            {"inbound_count": len(inbound), "distinct_senders": len(senders), "window_minutes": window_minutes},
        ))

    # RELATIONSHIP_NOVELTY (context)
    if ctx.pair_first.get((tx.src, tx.dst)) == tx.id:
        signals.append(_signal(
            "RELATIONSHIP_NOVELTY", 1.0,
            f"First observed transfer from {tx.src} to {tx.dst} in the available history (context only).",
            [tx.id], {},
        ))
        uncertainties.append("Relationship history only covers the available data window; "
                             "a 'new' relationship may pre-date the data.")

    # SHARED_DEVICE (context)
    if tx.device:
        accounts = ctx.device_accounts.get(tx.device, set())
        if len(accounts) >= SHARED_DEVICE_MIN_ACCOUNTS:
            signals.append(_signal(
                "SHARED_DEVICE", 1.0,
                f"Device {tx.device} is used by {len(accounts)} accounts ({', '.join(sorted(accounts))}). "
                f"Context only - shared devices have many legitimate explanations.",
                [tx.id], {"accounts": sorted(accounts), "min_accounts": SHARED_DEVICE_MIN_ACCOUNTS},
            ))
    else:
        uncertainties.append("Device identifier is missing; shared-device context could not be evaluated.")

    signals = [s for s in signals if s["value"] > 0]
    score = min(100, round_half_up(sum(s["contribution"] for s in signals)))
    return {
        "transaction_id": tx.id,
        "score": score,
        "risk_band": risk_band(score),
        "signals": sorted(signals, key=lambda s: -s["contribution"]),
        "uncertainties": uncertainties,
        "baseline": base,
        "rule_version": RULE_VERSION,
        "time_window_minutes": window_minutes,
    }


def assess_all(rows: list[dict], window_minutes: int = DEFAULT_WINDOW_MINUTES,
               overrides: dict | None = None) -> dict[str, dict]:
    txs = [Tx.from_row(r) for r in rows]
    ctx = RiskContext(txs)
    return {tx.id: assess(tx, ctx, window_minutes, overrides) for tx in ctx.txs}


def rules_description() -> list[dict]:
    """Human-readable rule catalogue (for the UI/README)."""
    return [
        {"code": "UNUSUAL_AMOUNT", "weight": WEIGHTS["UNUSUAL_AMOUNT"],
         "rule": f"Amount >= {UNUSUAL_RATIO_MIN}x source p90 baseline (full weight at {UNUSUAL_RATIO_FULL}x); "
                 f"half weight if no baseline and amount >= {HIGH_AMOUNT_NO_BASELINE:,}."},
        {"code": "VELOCITY", "weight": WEIGHTS["VELOCITY"],
         "rule": f">= {VELOCITY_MIN_COUNT} outgoing transfers from the source within +/- the analysis window."},
        {"code": "RAPID_ONWARD", "weight": WEIGHTS["RAPID_ONWARD"],
         "rule": f">= {ONWARD_FULL_RATIO:.0%} of the amount moves onward within {ONWARD_WINDOW_MINUTES} min "
                 f"(half weight at >= {ONWARD_PARTIAL_RATIO:.0%})."},
        {"code": "FAN_IN_RAPID_OUT", "weight": WEIGHTS["FAN_IN_RAPID_OUT"],
         "rule": f">= {FAN_IN_MIN_COUNT} inbound transfers from >= {FAN_IN_MIN_SENDERS} senders within the window before an outbound transfer."},
        {"code": "RELATIONSHIP_NOVELTY", "weight": WEIGHTS["RELATIONSHIP_NOVELTY"],
         "rule": "First observed source->destination pair (context only)."},
        {"code": "SHARED_DEVICE", "weight": WEIGHTS["SHARED_DEVICE"],
         "rule": f"Device used by >= {SHARED_DEVICE_MIN_ACCOUNTS} accounts (context only; cannot reach MEDIUM alone)."},
    ]
