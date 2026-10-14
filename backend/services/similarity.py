"""Similar-case lookup: compare a live case with the archive of resolved cases.

Primary method: Gemini text embeddings of a behavioural description of each case (no names or account IDs),
ranked by cosine similarity. Vectors are cached in SQLite, so the archive is embedded once.
Fallback when embeddings are unavailable: overlap of the rule signals that fired (deterministic).
Precedents show how comparable patterns ended; they are context for the analyst, not a prediction.
"""
import hashlib
import json
import math
import sqlite3
from collections import Counter
from datetime import date

from backend.config import settings
from backend.db import dumps
from backend.services import case_archive, gemini_service
from backend.services.risk_engine import LABELS, parse_ts

TOP_K = 3
EMBEDDING_WEIGHT = 0.6   # hybrid score: semantic similarity (rescaled across the archive) + rule-signal overlap
SIGNAL_WEIGHT = 0.4
CONTEXT_SIGNALS = {"RELATIONSHIP_NOVELTY"}


def case_fingerprint(case: dict, txs: list[dict], accounts: dict[str, dict]) -> str:
    """Plain-language description of the case's behaviour, free of names and identifiers."""
    ordered = sorted(txs, key=lambda t: (t["timestamp"], t["transaction_id"]))
    if not ordered:
        return "No transfers."
    span = int((parse_ts(ordered[-1]["timestamp"]) - parse_ts(ordered[0]["timestamp"])).total_seconds() // 60)
    out_deg = Counter(t["source_account"] for t in ordered)
    in_deg = Counter(t["destination_account"] for t in ordered)
    senders_into = {acc: {t["source_account"] for t in ordered if t["destination_account"] == acc} for acc in in_deg}
    max_out, max_in = max(out_deg.values()), max(len(s) for s in senders_into.values())
    relays = [a for a in in_deg if a in out_deg]
    codes = set(case["signal_codes"])
    first_day = ordered[0]["timestamp"][:10]
    recent = 0
    for acc_id in case["accounts"]:
        acc = accounts.get(acc_id) or {}
        try:
            age = (date.fromisoformat(first_day) - date.fromisoformat((acc.get("created_at") or "")[:10])).days
        except ValueError:
            continue
        if 0 <= age <= 30:
            recent += 1

    parts = [f"{len(ordered)} transfer{'s' if len(ordered) != 1 else ''} between {len(case['accounts'])} accounts "
             f"over {span} minutes."]
    if max_out >= 4:
        parts.append(f"One account sent {max_out} transfers to different accounts in a short burst (fan-out).")
    if max_in >= 4:
        parts.append(f"{max_in} different senders paid into one account in a short period (fan-in), "
                     f"followed by a transfer out.")
    elif max_in >= 2 and max_out >= 4:
        parts.append("The money was consolidated again into fewer accounts after passing through intermediaries.")
    if len(ordered) == 1:
        parts.append("A single transfer with no onward movement inside the case.")
    elif relays and max_out < 4 and max_in < 4:
        parts.append(f"The money passed through {len(relays)} intermediary account{'s' if len(relays) != 1 else ''} "
                     f"in a chain.")
    if "RAPID_ONWARD" in codes:
        parts.append("Recipients forwarded most of the money onward within thirty minutes.")
    if "UNUSUAL_AMOUNT" in codes:
        parts.append("At least one transfer was many times larger than the sender's usual amounts.")
    if "VELOCITY" in codes:
        parts.append("The sender made an unusually high number of transfers within an hour.")
    if "SHARED_DEVICE" in codes:
        parts.append("Several of the accounts were operated from the same device.")
    if "RELATIONSHIP_NOVELTY" in codes:
        parts.append("The payer had not paid these recipients before.")
    if recent:
        parts.append(f"{recent} of the {len(case['accounts'])} accounts were newly opened within the previous thirty days.")
    else:
        parts.append("All of the accounts are long-established; none was newly opened.")

    # How much of the first transfer was passed on by its recipient (full pass-through vs. partial payment).
    first = ordered[0]
    onward = sum(float(t["amount"]) for t in ordered[1:] if t["source_account"] == first["destination_account"])
    if onward and float(first["amount"]):
        share = onward / float(first["amount"])
        if share >= 0.9:
            parts.append("The first recipient passed on almost the full amount.")
        elif share >= 0.3:
            parts.append(f"The first recipient passed on only part of the amount (about {round(share * 100, -1):.0f} percent).")

    amounts = [float(t["amount"]) for t in ordered]
    if max(amounts) < 25_000:
        parts.append("All individual transfers were small amounts.")
    elif min(amounts) >= 1_000_000:
        parts.append("The transfers were very high-value payments.")

    kind = lambda a: (accounts.get(a) or {}).get("account_type", "PERSONAL")  # noqa: E731
    payer, payee = kind(first["source_account"]), kind(first["destination_account"])
    if payer == "PERSONAL" and payee in ("BUSINESS", "MERCHANT"):
        parts.append("A personal customer paid a business, and the business then paid another business or supplier."
                     if len(ordered) > 1 else "A personal customer paid a business.")
    elif payer == "BUSINESS":
        parts.append("The payer is a business account.")
    elif all(kind(a) == "PERSONAL" for a in case["accounts"]):
        parts.append("All accounts are personal accounts.")
    return " ".join(parts)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _signal_overlap(case_codes: list[str], entry_codes: list[str]) -> float:
    a, b = set(case_codes) - CONTEXT_SIGNALS, set(entry_codes) - CONTEXT_SIGNALS
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def _vectors(conn: sqlite3.Connection, texts: dict[str, str]) -> dict[str, list[float]]:
    """Return an embedding per key, reusing cached vectors whose text and model are unchanged."""
    model = settings.gemini_embedding_model
    out: dict[str, list[float]] = {}
    missing: list[str] = []
    for key, text in texts.items():
        digest = hashlib.sha256(f"{model}|{text}".encode()).hexdigest()
        row = conn.execute("SELECT vector_json FROM embeddings WHERE key = ? AND text_hash = ?", (key, digest)).fetchone()
        if row:
            out[key] = json.loads(row["vector_json"])
        else:
            missing.append(key)
    if missing:
        vectors = gemini_service.embed_texts([texts[k] for k in missing])
        for key, vec in zip(missing, vectors):
            digest = hashlib.sha256(f"{model}|{texts[key]}".encode()).hexdigest()
            conn.execute(
                "INSERT INTO embeddings(key, model, text_hash, vector_json) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash, "
                "vector_json = excluded.vector_json", (key, model, digest, dumps([round(v, 6) for v in vec])))
            out[key] = vec
    return out


def find_similar(conn: sqlite3.Connection, case: dict, txs: list[dict], accounts: dict[str, dict]) -> dict:
    description = case_fingerprint(case, txs, accounts)
    entries = case_archive.ARCHIVE
    method, model, reason = "GEMINI_EMBEDDINGS", settings.gemini_embedding_model, None
    try:
        texts = {e["archive_id"]: case_archive.fingerprint(e) for e in entries}
        texts[f"CASE:{case['case_id']}"] = description
        vectors = _vectors(conn, texts)
        query = vectors[f"CASE:{case['case_id']}"]
        cosines = {e["archive_id"]: _cosine(query, vectors[e["archive_id"]]) for e in entries}
        # Raw cosine values sit in a narrow band, so rescale them across the archive before blending with the
        # rule-signal overlap. The result is a relative match strength, not a probability.
        lo, hi = min(cosines.values()), max(cosines.values())
        spread = (hi - lo) or 1.0
        scored = [(e, EMBEDDING_WEIGHT * (cosines[e["archive_id"]] - lo) / spread
                   + SIGNAL_WEIGHT * _signal_overlap(case["signal_codes"], e["signal_codes"])) for e in entries]
    except gemini_service.GeminiUnavailable as exc:
        method, model, reason = "SIGNAL_OVERLAP", None, exc.reason
        scored = [(e, _signal_overlap(case["signal_codes"], e["signal_codes"])) for e in entries]

    scored.sort(key=lambda pair: (-pair[1], pair[0]["archive_id"]))

    def render(entry: dict, score: float) -> dict:
        shared = sorted(set(case["signal_codes"]) & set(entry["signal_codes"]))
        return {
            "archive_id": entry["archive_id"], "title": entry["title"], "pattern": entry["pattern"],
            "similarity": round(max(0.0, min(1.0, score)), 3),
            "outcome": entry["outcome"], "outcome_label": case_archive.OUTCOME_LABELS[entry["outcome"]],
            "resolution": entry["resolution"], "days_to_resolve": entry["days_to_resolve"],
            "actions_taken": entry["actions_taken"],
            "shared_signals": [{"code": c, "label": LABELS.get(c, c)} for c in shared],
        }

    top = [render(e, s) for e, s in scored[:TOP_K]]
    outcomes = Counter(t["outcome"] for t in top)
    # Guard against one-sided precedent lists: if the closest matches all ended the same way, also surface the
    # nearest case that ended differently, so the analyst always sees a counter-example.
    counter_example = None
    if len(outcomes) == 1:
        only = next(iter(outcomes))
        for e, s in scored[TOP_K:]:
            if e["outcome"] != only:
                counter_example = render(e, s)
                break
    return {
        "method": method, "model": model, "fallback_reason": reason,
        "case_description": description, "archive_size": len(entries),
        "matches": top,
        "counter_example": counter_example,
        "scoring": (f"{EMBEDDING_WEIGHT:.0%} Gemini embedding similarity (rescaled across the archive) + "
                    f"{SIGNAL_WEIGHT:.0%} rule-signal overlap" if method == "GEMINI_EMBEDDINGS"
                    else "Rule-signal overlap only (embeddings unavailable)"),
        "outcome_summary": {k: outcomes.get(k, 0) for k in case_archive.OUTCOME_LABELS},
        "note": "Precedents from a synthetic archive of resolved cases. They show how comparable patterns ended and "
                "are not a prediction for this case.",
    }
