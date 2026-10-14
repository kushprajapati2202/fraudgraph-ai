"""Case building (linking flagged transactions) and evidence assembly with stable evidence IDs.

Evidence ID conventions (stable within a dataset version):
  EV-<tx_id>                  transaction record           e.g. EV-TX-1042
  EV-SIG-<tx_id>-<RULE_CODE>  rule finding on a transaction e.g. EV-SIG-TX-1042-RAPID_ONWARD
  EV-BASE-<account_id>        baseline statistics           e.g. EV-BASE-AC-101
  EV-PATH-<n>                 time-respecting transfer path e.g. EV-PATH-1
"""
import hashlib
from collections import defaultdict
from datetime import timedelta

from backend.services import graph_engine
from backend.services.risk_engine import CASE_MIN_SCORE, CONTEXT_ONLY, LABELS, fmt_amount, parse_ts, risk_band


def tx_evidence_id(tx_id: str) -> str:
    return f"EV-{tx_id}"


def sig_evidence_id(tx_id: str, code: str) -> str:
    return f"EV-SIG-{tx_id}-{code}"


def base_evidence_id(account_id: str) -> str:
    return f"EV-BASE-{account_id}"


class _UnionFind:
    def __init__(self, items):
        self.parent = {i: i for i in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def build_cases(rows: list[dict], assessments: dict[str, dict], window_minutes: int) -> list[dict]:
    """Group flagged transactions (score >= MEDIUM threshold) that share an account within the window."""
    by_id = {r["transaction_id"]: r for r in rows}
    flagged = sorted(
        (r for r in rows if assessments[r["transaction_id"]]["score"] >= CASE_MIN_SCORE),
        key=lambda r: (r["timestamp"], r["transaction_id"]),
    )
    uf = _UnionFind([r["transaction_id"] for r in flagged])
    per_account: dict[str, list[dict]] = defaultdict(list)
    for r in flagged:
        per_account[r["source_account"]].append(r)
        per_account[r["destination_account"]].append(r)
    window = timedelta(minutes=window_minutes)
    for txs in per_account.values():
        for prev, cur in zip(txs, txs[1:]):
            if parse_ts(cur["timestamp"]) - parse_ts(prev["timestamp"]) <= window:
                uf.union(prev["transaction_id"], cur["transaction_id"])

    groups: dict[str, list[str]] = defaultdict(list)
    for r in flagged:
        groups[uf.find(r["transaction_id"])].append(r["transaction_id"])

    cases = []
    for tx_ids in groups.values():
        tx_ids = sorted(tx_ids, key=lambda t: (by_id[t]["timestamp"], t))
        anchor = tx_ids[0]
        accounts = sorted({a for t in tx_ids for a in (by_id[t]["source_account"], by_id[t]["destination_account"])})
        score = max(assessments[t]["score"] for t in tx_ids)
        totals: dict[str, float] = defaultdict(float)
        for t in tx_ids:
            for s in assessments[t]["signals"]:
                totals[s["code"]] += s["contribution"]
        codes = sorted(totals, key=lambda c: (-totals[c], c))
        cases.append({
            "case_id": "CASE-" + hashlib.sha1(anchor.encode()).hexdigest()[:6].upper(),
            "title": _title(codes, by_id[anchor], accounts, tx_ids),
            "risk_score": score,
            "risk_band": risk_band(score),
            "transaction_ids": tx_ids,
            "accounts": accounts,
            "signal_codes": codes,
        })
    return sorted(cases, key=lambda c: (-c["risk_score"], c["case_id"]))


def _title(codes: list[str], anchor: dict, accounts: list[str], tx_ids: list[str]) -> str:
    primary = next((c for c in codes if c not in CONTEXT_ONLY), codes[0] if codes else None)
    label = LABELS.get(primary, "Flagged activity")
    return f"{label} from {anchor['source_account']} - {len(accounts)} accounts, {len(tx_ids)} transfers"


def build_evidence(case: dict, rows_by_id: dict[str, dict], assessments: dict[str, dict], window_minutes: int) -> list[dict]:
    tx_rows = [rows_by_id[t] for t in case["transaction_ids"]]
    items: list[dict] = []

    for n, path in enumerate(graph_engine.time_respecting_paths(tx_rows, max_gap_minutes=window_minutes), start=1):
        items.append({
            "evidence_id": f"EV-PATH-{n}",
            "source_type": "GRAPH_PATH",
            "source_id": ",".join(path["transaction_ids"]),
            "description": (f"Transfer path {' -> '.join(path['accounts'])} via {', '.join(path['transaction_ids'])} "
                            f"over {path['duration_minutes']} minutes."),
            "timestamp": path["start"],
            "payload": {**path, "supporting_evidence_ids": [tx_evidence_id(t) for t in path["transaction_ids"]]},
        })

    signal_items = []
    for r in tx_rows:
        for s in assessments[r["transaction_id"]]["signals"]:
            signal_items.append({
                "evidence_id": sig_evidence_id(r["transaction_id"], s["code"]),
                "source_type": "RULE_FINDING",
                "source_id": r["transaction_id"],
                "description": f"{s['label']} (+{s['contribution']:g} of {s['weight']}): {s['explanation']}",
                "timestamp": r["timestamp"],
                "payload": {
                    "code": s["code"], "label": s["label"], "weight": s["weight"], "value": s["value"],
                    "contribution": s["contribution"], "context_only": s["context_only"], "params": s["params"],
                    "supporting_evidence_ids": [tx_evidence_id(t) for t in s["supporting_tx_ids"]],
                    "supporting_tx_ids": s["supporting_tx_ids"],
                },
            })
    items += sorted(signal_items, key=lambda i: (-i["payload"]["contribution"], i["evidence_id"]))

    for r in tx_rows:
        a = assessments[r["transaction_id"]]
        items.append({
            "evidence_id": tx_evidence_id(r["transaction_id"]),
            "source_type": "TRANSACTION",
            "source_id": r["transaction_id"],
            "description": (f"{r['source_account']} -> {r['destination_account']}: {fmt_amount(float(r['amount']))} "
                            f"{r['currency']} via {r['channel']} at {r['timestamp']} (score {a['score']}, {a['risk_band']})."),
            "timestamp": r["timestamp"],
            "payload": {
                "transaction_id": r["transaction_id"], "source_account": r["source_account"],
                "destination_account": r["destination_account"], "amount": float(r["amount"]),
                "currency": r["currency"], "timestamp": r["timestamp"], "channel": r["channel"],
                "device_id": r.get("device_id") or None, "description": r.get("description") or "",
                "is_synthetic_added": bool(r.get("is_synthetic_added")),
                "score": a["score"], "risk_band": a["risk_band"], "uncertainties": a["uncertainties"],
            },
        })

    seen = set()
    for r in tx_rows:
        acc = r["source_account"]
        if acc in seen:
            continue
        seen.add(acc)
        base = assessments[r["transaction_id"]]["baseline"]
        if base["available"]:
            desc = (f"Baseline for {acc} before {r['timestamp']}: median {fmt_amount(base['median_amount'])}, "
                    f"90th percentile {fmt_amount(base['p90_amount'])} from {base['prior_outgoing_count']} prior payments.")
        else:
            desc = (f"No baseline for {acc}: only {base['prior_outgoing_count']} prior outgoing payment(s) "
                    f"before {r['timestamp']}. Amount unusualness is uncertain.")
        items.append({
            "evidence_id": base_evidence_id(acc),
            "source_type": "BASELINE",
            "source_id": acc,
            "description": desc,
            "timestamp": r["timestamp"],
            "payload": {**base, "as_of": r["timestamp"]},
        })

    for order, item in enumerate(items):
        item["sort_order"] = order
    return items
