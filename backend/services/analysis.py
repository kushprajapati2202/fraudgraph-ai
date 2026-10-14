"""Analysis run orchestration: score every transaction, (re)build cases and evidence, record a diff."""
import json
import sqlite3

from backend.db import dumps, rows_to_dicts, utcnow
from backend.errors import AppError
from backend.services import audit, investigation, risk_engine, synthetic_data

MAX_DIFF_TRANSACTIONS = 50


def load_transactions(conn: sqlite3.Connection) -> list[dict]:
    return rows_to_dicts(conn.execute("SELECT * FROM transactions ORDER BY timestamp, transaction_id").fetchall())


def _snapshot(conn: sqlite3.Connection) -> tuple[dict, dict]:
    tx = {}
    for r in conn.execute("SELECT transaction_id, score, risk_band, signals_json FROM risk_assessments"):
        tx[r["transaction_id"]] = {
            "score": r["score"], "risk_band": r["risk_band"],
            "codes": {s["code"] for s in json.loads(r["signals_json"])},
        }
    cases = {}
    for r in conn.execute("SELECT case_id, risk_score, risk_band, transaction_ids_json FROM cases WHERE active = 1"):
        cases[r["case_id"]] = {"risk_score": r["risk_score"], "risk_band": r["risk_band"],
                               "transaction_ids": json.loads(r["transaction_ids_json"])}
    return tx, cases


def run(conn: sqlite3.Connection, time_window_minutes: int = risk_engine.DEFAULT_WINDOW_MINUTES,
        scenario_id: str | None = None) -> dict:
    known = {s["scenario_id"] for s in synthetic_data.SCENARIOS}
    if scenario_id and scenario_id not in known:
        raise AppError(422, "VALIDATION_ERROR", f"Unknown scenario_id '{scenario_id}'.",
                       [{"field": "scenario_id", "allowed": sorted(known)}])

    before_tx, before_cases = _snapshot(conn)
    rows = load_transactions(conn)
    assessments = risk_engine.assess_all(rows, time_window_minutes)
    run_no = conn.execute("SELECT COUNT(*) FROM analysis_runs").fetchone()[0] + 1
    analysis_id = f"AN-{run_no:04d}"
    now = utcnow()

    conn.execute("DELETE FROM risk_assessments")
    conn.executemany(
        "INSERT INTO risk_assessments(assessment_id, transaction_id, score, risk_band, signals_json, uncertainties_json, "
        "rule_version, analysis_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(f"RA-{a['transaction_id']}", a["transaction_id"], a["score"], a["risk_band"],
          dumps(a["signals"]), dumps({"uncertainties": a["uncertainties"], "baseline": a["baseline"],
                                      "time_window_minutes": time_window_minutes}),
          risk_engine.RULE_VERSION, analysis_id, now) for a in assessments.values()],
    )

    cases = investigation.build_cases(rows, assessments, time_window_minutes)
    rows_by_id = {r["transaction_id"]: r for r in rows}
    existing = {r["case_id"]: dict(r) for r in conn.execute("SELECT * FROM cases")}
    new_ids = set()
    diff_new, diff_updated = [], []
    for case in cases:
        cid = case["case_id"]
        new_ids.add(cid)
        values = (case["title"], case["risk_score"], case["risk_band"], dumps(case["transaction_ids"]),
                  dumps(case["accounts"]), dumps(case["signal_codes"]), risk_engine.RULE_VERSION, analysis_id, now)
        if cid in existing:
            conn.execute(
                "UPDATE cases SET title=?, risk_score=?, risk_band=?, transaction_ids_json=?, accounts_json=?, "
                "signal_codes_json=?, rule_version=?, analysis_id=?, updated_at=?, active=1 WHERE case_id=?",
                (*values, cid),
            )
        else:
            conn.execute(
                "INSERT INTO cases(title, risk_score, risk_band, transaction_ids_json, accounts_json, signal_codes_json, "
                "rule_version, analysis_id, updated_at, case_id, status, created_at, active) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, 1)",
                (*values, cid, now),
            )

        prev = before_cases.get(cid)
        if prev is None:
            diff_new.append({"case_id": cid, "title": case["title"], "risk_score": case["risk_score"],
                             "risk_band": case["risk_band"]})
            audit.record(conn, "CASE_CREATED", audit.ACTOR_SYSTEM,
                         {"analysis_id": analysis_id, "risk_score": case["risk_score"], "rule_version": risk_engine.RULE_VERSION,
                          "transaction_count": len(case["transaction_ids"])}, cid)
        elif prev["risk_score"] != case["risk_score"] or prev["transaction_ids"] != case["transaction_ids"]:
            added = [t for t in case["transaction_ids"] if t not in prev["transaction_ids"]]
            diff_updated.append({"case_id": cid, "title": case["title"], "score_before": prev["risk_score"],
                                 "score_after": case["risk_score"], "band_before": prev["risk_band"],
                                 "band_after": case["risk_band"], "added_transaction_ids": added})
            audit.record(conn, "CASE_UPDATED", audit.ACTOR_SYSTEM,
                         {"analysis_id": analysis_id, "score_before": prev["risk_score"],
                          "score_after": case["risk_score"], "added_transaction_ids": added}, cid)

        conn.execute("DELETE FROM case_evidence WHERE case_id = ?", (cid,))
        conn.executemany(
            "INSERT INTO case_evidence(case_id, evidence_id, source_type, source_id, description, timestamp, payload_json, "
            "sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(cid, e["evidence_id"], e["source_type"], e["source_id"], e["description"], e["timestamp"],
              dumps(e["payload"]), e["sort_order"])
             for e in investigation.build_evidence(case, rows_by_id, assessments, time_window_minutes)],
        )

    deactivated = []
    for cid, prev in existing.items():
        if cid not in new_ids and prev["active"]:
            conn.execute("UPDATE cases SET active = 0, updated_at = ? WHERE case_id = ?", (now, cid))
            deactivated.append(cid)
            audit.record(conn, "CASE_NO_LONGER_FLAGGED", audit.ACTOR_SYSTEM, {"analysis_id": analysis_id}, cid)

    first_run = not before_tx
    changed_tx, new_tx = [], []
    if not first_run:
        for tx_id, a in assessments.items():
            prev = before_tx.get(tx_id)
            codes = {s["code"] for s in a["signals"]}
            if prev is None:
                new_tx.append(tx_id)
            if prev is None or prev["score"] != a["score"] or prev["codes"] != codes:
                changed_tx.append({
                    "transaction_id": tx_id,
                    "score_before": prev["score"] if prev else None,
                    "score_after": a["score"],
                    "band_before": prev["risk_band"] if prev else None,
                    "band_after": a["risk_band"],
                    "added_signals": sorted(codes - (prev["codes"] if prev else set())),
                    "removed_signals": sorted((prev["codes"] if prev else set()) - codes),
                })
        changed_tx.sort(key=lambda c: (-(c["score_after"] - (c["score_before"] or 0)), c["transaction_id"]))

    diff = {
        "first_run": first_run,
        "new_cases": diff_new if not first_run else [],
        "updated_cases": diff_updated,
        "deactivated_cases": deactivated,
        "new_transactions": new_tx,
        "changed_transactions": changed_tx[:MAX_DIFF_TRANSACTIONS],
        "changed_transactions_total": len(changed_tx),
    }

    focus_case_ids = []
    if scenario_id:
        scenario_tx = {r["transaction_id"] for r in conn.execute(
            "SELECT transaction_id FROM labels WHERE scenario_id = ?", (scenario_id,))}
        focus_case_ids = [c["case_id"] for c in cases if scenario_tx & set(c["transaction_ids"])]

    params = {"time_window_minutes": time_window_minutes, "scenario_id": scenario_id}
    conn.execute(
        "INSERT INTO analysis_runs(analysis_id, params_json, transactions_analyzed, cases_created, rule_version, "
        "diff_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (analysis_id, dumps(params), len(rows), len(diff_new), risk_engine.RULE_VERSION, dumps(diff), now),
    )
    audit.record(conn, "ANALYSIS_RUN", audit.ACTOR_SYSTEM,
                 {"analysis_id": analysis_id, "rule_version": risk_engine.RULE_VERSION, **params,
                  "transactions_analyzed": len(rows), "active_cases": len(cases)})

    return {
        "analysis_id": analysis_id,
        "rule_version": risk_engine.RULE_VERSION,
        "time_window_minutes": time_window_minutes,
        "transactions_analyzed": len(rows),
        "cases_created": len(diff_new) if not first_run else len(cases),
        "active_cases": len(cases),
        "focus_case_ids": focus_case_ids,
        "diff": diff,
    }
