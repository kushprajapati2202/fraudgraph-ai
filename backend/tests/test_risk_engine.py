from datetime import datetime, timedelta

from backend.services.risk_engine import WEIGHTS, assess_all, risk_band

T0 = datetime(2026, 9, 10, 10, 0)


def tx(tx_id, src, dst, amount, minutes, device=None):
    return {"transaction_id": tx_id, "source_account": src, "destination_account": dst, "amount": amount,
            "timestamp": (T0 + timedelta(minutes=minutes)).isoformat(), "device_id": device}


def history(src, n=5, amount=1000, start_days=-9):
    return [tx(f"TX-H{src[-3:]}{i}", src, f"AC-8{i:02d}", amount, (start_days + i) * 1440) for i in range(n)]


def signal(assessment, code):
    return next((s for s in assessment["signals"] if s["code"] == code), None)


def test_unusual_amount_with_baseline():
    rows = history("AC-101") + [tx("TX-9", "AC-101", "AC-200", 20000, 0)]
    a = assess_all(rows)["TX-9"]
    s = signal(a, "UNUSUAL_AMOUNT")
    assert s and s["contribution"] == WEIGHTS["UNUSUAL_AMOUNT"]
    assert a["baseline"]["available"]


def test_normal_amount_does_not_fire():
    rows = history("AC-101") + [tx("TX-9", "AC-101", "AC-200", 1500, 0)]
    assert signal(assess_all(rows)["TX-9"], "UNUSUAL_AMOUNT") is None


def test_missing_baseline_is_disclosed():
    rows = history("AC-101", n=2) + [tx("TX-9", "AC-101", "AC-200", 50000, 0)]
    a = assess_all(rows)["TX-9"]
    assert signal(a, "UNUSUAL_AMOUNT") is None
    assert any("No baseline" in u for u in a["uncertainties"])

    rows = history("AC-101", n=2) + [tx("TX-9", "AC-101", "AC-200", 150000, 0)]
    s = signal(assess_all(rows)["TX-9"], "UNUSUAL_AMOUNT")
    assert s and s["value"] == 0.5 and s["params"]["baseline_missing"]


def test_velocity():
    rows = [tx(f"TX-{i}", "AC-101", f"AC-2{i:02d}", 500, i * 5) for i in range(5)]
    a = assess_all(rows)["TX-0"]
    s = signal(a, "VELOCITY")
    assert s and s["params"]["count"] == 5 and s["value"] == 0.75


def test_rapid_onward_flags_both_legs():
    rows = [tx("TX-1", "AC-101", "AC-102", 100000, 0), tx("TX-2", "AC-102", "AC-103", 90000, 10)]
    out = assess_all(rows)
    assert signal(out["TX-1"], "RAPID_ONWARD")["value"] == 1.0
    assert signal(out["TX-2"], "RAPID_ONWARD")["value"] == 1.0
    assert "TX-2" in signal(out["TX-1"], "RAPID_ONWARD")["supporting_tx_ids"]


def test_rapid_onward_outside_window_does_not_fire():
    rows = [tx("TX-1", "AC-101", "AC-102", 100000, 0), tx("TX-2", "AC-102", "AC-103", 90000, 45)]
    assert signal(assess_all(rows)["TX-1"], "RAPID_ONWARD") is None


def test_fan_in_rapid_out():
    rows = [tx(f"TX-{i}", f"AC-3{i:02d}", "AC-500", 9000, i * 4) for i in range(6)]
    rows.append(tx("TX-9", "AC-500", "AC-600", 50000, 28))
    s = signal(assess_all(rows)["TX-9"], "FAN_IN_RAPID_OUT")
    assert s and s["value"] == 1.0 and s["params"]["distinct_senders"] == 6


def test_shared_device_alone_stays_low():
    rows = []
    for acc in ("AC-101", "AC-102", "AC-103"):
        rows += history(acc, amount=1000)
        rows.append(tx(f"TX-D{acc[-3:]}", acc, "AC-900", 900, int(acc[-1]) * 300, device="DEV-1"))
    for tx_id, a in assess_all(rows).items():
        if tx_id.startswith("TX-D"):
            assert signal(a, "SHARED_DEVICE")["contribution"] == WEIGHTS["SHARED_DEVICE"]
            assert a["risk_band"] == "LOW"


def test_bands_and_cap():
    assert risk_band(0) == "LOW" and risk_band(29) == "LOW"
    assert risk_band(30) == "MEDIUM" and risk_band(59) == "MEDIUM"
    assert risk_band(60) == "HIGH" and risk_band(100) == "HIGH"
    assert sum(WEIGHTS.values()) == 100


def test_deterministic():
    rows = history("AC-101") + [tx("TX-1", "AC-101", "AC-102", 100000, 0), tx("TX-2", "AC-102", "AC-103", 90000, 10)]
    assert assess_all(rows) == assess_all(list(reversed(rows)))
