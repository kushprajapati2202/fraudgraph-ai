"""Evaluate the rule engine against synthetic labels and (optionally) measure in-process API latency.

Usage: python scripts/evaluate.py [--latency] [--out docs/evaluation.md]
Metrics are measured on the synthetic dataset only; they say nothing about real-world performance.
"""
import argparse
import json
import statistics
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL_MINUTES_PER_RECORD = 2.0  # assumption used only for the illustrative effort estimate
sys.path.insert(0, str(ROOT))

from backend.config import DATASET_VERSION  # noqa: E402
from backend.services import synthetic_data  # noqa: E402
from backend.services.investigation import build_cases, build_evidence  # noqa: E402
from backend.services.risk_engine import BAND_THRESHOLDS, RULE_VERSION, assess_all  # noqa: E402


def confusion(pred: dict[str, bool], truth: dict[str, bool]) -> dict:
    tp = sum(1 for k in truth if pred[k] and truth[k])
    fp = sum(1 for k in truth if pred[k] and not truth[k])
    fn = sum(1 for k in truth if not pred[k] and truth[k])
    tn = sum(1 for k in truth if not pred[k] and not truth[k])
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "fpr": fp / (fp + tn) if fp + tn else None,
    }


def pct(x) -> str:
    return "n/a" if x is None else f"{x:.1%}"


def evaluate() -> dict:
    _, txs, labels = synthetic_data.generate()
    t0 = time.perf_counter()
    assessments = assess_all(txs)
    cases = build_cases(txs, assessments, 60)
    engine_ms = (time.perf_counter() - t0) * 1000

    truth = {l["transaction_id"]: l["label"] == "SUSPICIOUS" for l in labels}
    in_case = {t for c in cases for t in c["transaction_ids"]}
    tx_level = {
        "MEDIUM+ (score >= 30, case created)": confusion({k: k in in_case for k in truth}, truth),
        "HIGH (score >= 60)": confusion({k: assessments[k]["score"] >= BAND_THRESHOLDS["HIGH"] for k in truth}, truth),
    }

    scenario_rows = []
    by_scenario = defaultdict(list)
    for l in labels:
        by_scenario[l["scenario_id"]].append(l["transaction_id"])
    for s in synthetic_data.SCENARIOS:
        ids = by_scenario[s["scenario_id"]]
        flagged_cases = [c for c in cases if set(ids) & set(c["transaction_ids"])]
        scenario_rows.append({
            "scenario_id": s["scenario_id"], "label": s["label"], "transactions": len(ids),
            "max_score": max(assessments[t]["score"] for t in ids),
            "case_band": max((c["risk_band"] for c in flagged_cases), key=["LOW", "MEDIUM", "HIGH"].index, default="-"),
            "flagged_txs": sum(1 for t in ids if t in in_case),
        })

    suspicious_cases = sum(1 for c in cases if any(truth[t] for t in c["transaction_ids"]))

    # Investigation effort: what the system assembles per case that an analyst would otherwise collect by hand.
    rows_by_id = {t["transaction_id"]: t for t in txs}
    effort = []
    for c in cases:
        t1 = time.perf_counter()
        evidence = build_evidence(c, rows_by_id, assessments, 60)
        build_ms = (time.perf_counter() - t1) * 1000
        records = len(c["transaction_ids"]) + len(c["accounts"])  # source records to open manually
        effort.append({"case_id": c["case_id"], "band": c["risk_band"], "transfers": len(c["transaction_ids"]),
                       "accounts": len(c["accounts"]), "evidence": len(evidence),
                       "paths": sum(1 for e in evidence if e["source_type"] == "GRAPH_PATH"),
                       "records": records, "build_ms": build_ms})
    return {
        "transactions": len(txs), "suspicious": sum(truth.values()), "cases": len(cases),
        "suspicious_cases": suspicious_cases, "tx_level": tx_level, "scenarios": scenario_rows,
        "engine_ms": engine_ms,
        "effort": effort,
        "case_bands": {b: sum(1 for c in cases if c["risk_band"] == b) for b in ("HIGH", "MEDIUM")},
    }


def measure_latency(iterations: int = 20) -> list[dict]:
    from fastapi.testclient import TestClient

    from backend.config import settings

    tmp = tempfile.mkdtemp()
    settings.db_path = str(Path(tmp) / "latency.db")
    settings.gemini_api_key = None
    from backend.main import app

    results = []
    with TestClient(app) as client:
        case_id = client.get("/api/cases").json()["items"][0]["case_id"]
        endpoints = [
            ("GET /api/dashboard", lambda: client.get("/api/dashboard")),
            ("GET /api/transactions", lambda: client.get("/api/transactions", params={"min_amount": 1000})),
            ("GET /api/cases/{id}", lambda: client.get(f"/api/cases/{case_id}")),
            ("GET /api/graph?case_id", lambda: client.get("/api/graph", params={"case_id": case_id})),
            ("POST /api/analysis/run", lambda: client.post("/api/analysis/run", json={})),
        ]
        for name, call in endpoints:
            samples = []
            for _ in range(iterations):
                t = time.perf_counter()
                assert call().status_code == 200
                samples.append((time.perf_counter() - t) * 1000)
            samples.sort()
            results.append({"endpoint": name, "p50": statistics.median(samples),
                            "p95": samples[min(len(samples) - 1, int(0.95 * len(samples)))]})
    return results


def render(m: dict, latency: list[dict] | None) -> str:
    lines = [
        "# FraudGraph AI - Evaluation (synthetic data)",
        "",
        f"Dataset `{DATASET_VERSION}` (seed {synthetic_data.SEED}), rules `{RULE_VERSION}`, analysis window 60 minutes.",
        "Generated by `python scripts/evaluate.py`. **All figures describe a fictional, self-generated dataset and "
        "do not predict real-world performance.**",
        "",
        "## Method",
        "",
        "- Every transaction carries a ground-truth label (`SUSPICIOUS` or `LEGIT`) from the generator "
        "(`data/labels.csv`). Background traffic and lookalike scenarios are `LEGIT`.",
        "- The risk engine never reads labels. Predictions are made at the transaction level.",
        "- *MEDIUM+*: the transaction scored >= 30 and became part of a case. *HIGH*: score >= 60.",
        "- Precision = TP/(TP+FP); recall = TP/(TP+FN); false-positive rate = FP/(FP+TN).",
        "",
        "## Dataset",
        "",
        f"- Transactions: {m['transactions']} ({m['suspicious']} labeled suspicious)",
        f"- Cases created: {m['cases']} (HIGH {m['case_bands']['HIGH']}, MEDIUM {m['case_bands']['MEDIUM']}); "
        f"cases containing a labeled-suspicious transaction: {m['suspicious_cases']}",
        f"- Engine time (score all transactions + build cases, in-process): {m['engine_ms']:.0f} ms",
        "",
        "## Transaction-level results",
        "",
        "| Threshold | TP | FP | FN | TN | Precision | Recall | FPR |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for name, c in m["tx_level"].items():
        lines.append(f"| {name} | {c['tp']} | {c['fp']} | {c['fn']} | {c['tn']} | {pct(c['precision'])} | "
                     f"{pct(c['recall'])} | {pct(c['fpr'])} |")
    lines += ["", "## Scenario results", "",
              "| Scenario | Label | Transactions | Flagged | Max score | Case band |", "|---|---|---|---|---|---|"]
    for s in m["scenarios"]:
        lines.append(f"| {s['scenario_id']} | {s['label']} | {s['transactions']} | {s['flagged_txs']} | "
                     f"{s['max_score']} | {s['case_band']} |")
    effort = m["effort"]
    if effort:
        total_records = sum(e["records"] for e in effort)
        total_evidence = sum(e["evidence"] for e in effort)
        lines += ["", "## Investigation effort (what is assembled automatically)", "",
                  "| Case | Band | Transfers | Accounts | Evidence items | Traced paths | Assembly time |",
                  "|---|---|---|---|---|---|---|"]
        for e in effort:
            lines.append(f"| {e['case_id']} | {e['band']} | {e['transfers']} | {e['accounts']} | {e['evidence']} | "
                         f"{e['paths']} | {e['build_ms']:.1f} ms |")
        lines += [
            "",
            f"- Across {len(effort)} cases the system links {total_records} source records (transfers and accounts) and "
            f"assembles {total_evidence} cited evidence items, on average {total_evidence / len(effort):.0f} per case.",
            f"- **Illustrative estimate, not a measurement:** if an analyst needs {MANUAL_MINUTES_PER_RECORD:g} minutes to open and "
            f"note each source record by hand, assembling these cases manually would take about "
            f"{total_records * MANUAL_MINUTES_PER_RECORD:.0f} minutes "
            f"({total_records * MANUAL_MINUTES_PER_RECORD / len(effort):.0f} per case). The per-record time is an assumption; "
            f"validate it with real analysts before quoting a saving.",
            "- Gemini drafting time is not included here; it depends on the model and current load.",
        ]
    if latency:
        lines += ["", "## API latency (in-process TestClient, no network, Gemini excluded)", "",
                  "| Endpoint | p50 ms | p95 ms |", "|---|---|---|"]
        for r in latency:
            lines.append(f"| {r['endpoint']} | {r['p50']:.1f} | {r['p95']:.1f} |")
        lines.append("")
        lines.append("Measured on the developer machine; re-measure on Cloud Run with `scripts/smoke.ps1` timings.")
    external = ROOT / "docs" / "evaluation-external.json"
    if external.exists():
        x = json.loads(external.read_text(encoding="utf-8"))
        lines += [
            "", "## Independent test (public dataset)", "",
            f"The same rules, unchanged, were also run on a dataset this team did not design: [{x['dataset']}]({x['source']}) "
            f"({x['license']}). The slice has {x['transactions']:,} transfers, of which {x['laundering']:,} "
            f"({x['base_rate']:.3%}) are labeled laundering. Full results: [evaluation-external.md](evaluation-external.md).",
            "",
            "| Threshold | Flagged | TP | Precision | Recall | FPR | Lift over base rate |", "|---|---|---|---|---|---|---|",
        ]
        for name, c in x["tx_level"].items():
            lines.append(f"| {name} | {c['flagged']:,} | {c['tp']:,} | {c['precision']:.2%} | {pct(c['recall'])} | "
                         f"{c['fpr']:.2%} | {c['lift']:.1f}x |")
        lines += ["", "These figures are far weaker than the ones above. On data they were not written for, a flagged "
                  "transfer is only about two to three times more likely to be laundering than a random one, mainly because that dataset's patterns unfold over hours or days and the rules "
                  "watch 30 to 60 minute windows."]
    lines += [
        "", "## Limitations", "",
        "- The generator and rules were designed by the same team, so scenarios are easier than real data. The independent "
        "test above shows how large that advantage is.",
        "- Lookalike scenarios (legitimate high-value payment, shared family device) are intentionally included and "
        "show up as false positives at MEDIUM+; that is expected for a prioritization score.",
        "- Background traffic occasionally produces rapid-onward coincidences; these are reported as false positives.",
        "- Relationship novelty and baselines only use the two-month synthetic window.",
        "- The score is a rule-based prioritization index, not a calibrated probability.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--latency", action="store_true")
    parser.add_argument("--out", default=str(ROOT / "docs" / "evaluation.md"))
    args = parser.parse_args()
    metrics = evaluate()
    latency = measure_latency() if args.latency else None
    report = render(metrics, latency)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(report, encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
