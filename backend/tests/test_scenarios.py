"""Scenario tests T-01..T-04 on the generated synthetic dataset (no database needed)."""
from collections import defaultdict

import pytest

from backend.services import synthetic_data
from backend.services.investigation import build_cases, build_evidence
from backend.services.risk_engine import assess_all


@pytest.fixture(scope="module")
def pipeline():
    accounts, txs, labels = synthetic_data.generate()
    assessments = assess_all(txs)
    cases = build_cases(txs, assessments, 60)
    by_scenario = defaultdict(list)
    for l in labels:
        by_scenario[l["scenario_id"]].append(l["transaction_id"])
    return {"txs": {t["transaction_id"]: t for t in txs}, "assessments": assessments, "cases": cases,
            "by_scenario": by_scenario}


def codes(assessment):
    return {s["code"] for s in assessment["signals"]}


def cases_for(p, scenario):
    tx_ids = set(p["by_scenario"][scenario])
    return [c for c in p["cases"] if tx_ids & set(c["transaction_ids"])]


def test_generator_is_deterministic():
    assert synthetic_data.generate() == synthetic_data.generate()


def test_dataset_size_and_labels(pipeline):
    assert 1000 <= len(pipeline["txs"]) <= 2000
    for s in synthetic_data.SCENARIOS:
        assert pipeline["by_scenario"][s["scenario_id"]], s["scenario_id"]


def test_t01_layered_transfer_is_one_high_case_with_path(pipeline):
    layered = pipeline["by_scenario"]["layered-transfer-01"]
    assert len(layered) == 12
    found = cases_for(pipeline, "layered-transfer-01")
    assert len(found) == 1
    case = found[0]
    assert set(layered) <= set(case["transaction_ids"])
    assert case["risk_band"] == "HIGH"
    assert {"RAPID_ONWARD", "VELOCITY", "UNUSUAL_AMOUNT"} <= set(case["signal_codes"])

    evidence = build_evidence(case, pipeline["txs"], pipeline["assessments"], 60)
    paths = [e for e in evidence if e["source_type"] == "GRAPH_PATH"]
    assert paths and max(len(p["payload"]["transaction_ids"]) for p in paths) >= 3
    for e in evidence:  # every transaction evidence item maps to a real record
        if e["source_type"] == "TRANSACTION":
            assert e["source_id"] in pipeline["txs"]
    assert len({e["evidence_id"] for e in evidence}) == len(evidence)


def test_suspicious_scenarios_reach_medium_or_high(pipeline):
    fan = cases_for(pipeline, "fan-in-out-01")
    assert len(fan) == 1 and fan[0]["risk_band"] == "HIGH"
    assert "FAN_IN_RAPID_OUT" in fan[0]["signal_codes"]
    rapid = cases_for(pipeline, "rapid-onward-01")
    assert len(rapid) == 1 and set(pipeline["by_scenario"]["rapid-onward-01"]) <= set(rapid[0]["transaction_ids"])
    assert rapid[0]["risk_band"] in ("MEDIUM", "HIGH")


def test_t02_legit_high_value_is_not_high(pipeline):
    ids = pipeline["by_scenario"]["legit-high-value-01"]
    payment = pipeline["assessments"][ids[0]]
    assert "UNUSUAL_AMOUNT" in codes(payment)
    assert all(pipeline["assessments"][t]["risk_band"] != "HIGH" for t in ids)


def test_t03_shared_device_is_context_only(pipeline):
    ids = pipeline["by_scenario"]["shared-device-01"]
    for t in ids:
        a = pipeline["assessments"][t]
        shared = next(s for s in a["signals"] if s["code"] == "SHARED_DEVICE")
        assert shared["context_only"] and shared["contribution"] <= 10
        if codes(a) <= {"SHARED_DEVICE", "RELATIONSHIP_NOVELTY"}:
            assert a["risk_band"] == "LOW"
    assert all(pipeline["assessments"][t]["risk_band"] != "HIGH" for t in ids)


def test_t04_missing_baseline_reports_uncertainty(pipeline):
    (tx_id,) = pipeline["by_scenario"]["missing-baseline-01"]
    a = pipeline["assessments"][tx_id]
    assert a["baseline"]["available"] is False
    assert any("No baseline" in u for u in a["uncertainties"])
    assert any("Device identifier is missing" in u for u in a["uncertainties"])


def test_repeated_payments_stay_low(pipeline):
    assert all(pipeline["assessments"][t]["risk_band"] == "LOW" for t in pipeline["by_scenario"]["repeated-payments-01"])
