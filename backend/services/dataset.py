"""Load the fixed synthetic dataset into SQLite (demo reset)."""
import csv
import sqlite3
from pathlib import Path

from backend.config import DATASET_VERSION, settings
from backend.db import drop_all, init_schema, set_meta, utcnow
from backend.services import audit, synthetic_data


def _read(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def ensure_csvs(data_dir: str | Path) -> Path:
    data = Path(data_dir)
    tx_file = data / "demo_transactions.csv"
    # Regenerate when missing or produced by an older generator (no reference column).
    if not tx_file.exists() or "reference" not in tx_file.open(encoding="utf-8").readline():
        synthetic_data.write_csvs(data)
    return data


def reset(conn: sqlite3.Connection) -> dict:
    data = ensure_csvs(settings.data_dir)
    accounts = _read(data / "accounts.csv")
    transactions = _read(data / "demo_transactions.csv")
    labels = _read(data / "labels.csv")

    drop_all(conn)
    init_schema(conn)
    conn.executemany(
        "INSERT INTO accounts(account_id, account_type, created_at, demo_label, holder_name, account_number, city, "
        "branch_code, kyc_tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(a["account_id"], a["account_type"], a["created_at"], a["demo_label"], a.get("holder_name"),
          a.get("account_number"), a.get("city"), a.get("branch_code"), a.get("kyc_tier")) for a in accounts],
    )
    conn.executemany(
        "INSERT INTO transactions(transaction_id, source_account, destination_account, amount, currency, timestamp, "
        "channel, device_id, description, reference, is_synthetic_added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        [(t["transaction_id"], t["source_account"], t["destination_account"], float(t["amount"]), t["currency"],
          t["timestamp"], t["channel"], t["device_id"] or None, t["description"] or None, t.get("reference") or None)
         for t in transactions],
    )
    conn.executemany(
        "INSERT INTO labels(transaction_id, scenario_id, label) VALUES (?, ?, ?)",
        [(l["transaction_id"], l["scenario_id"], l["label"]) for l in labels],
    )
    set_meta(conn, "dataset_version", DATASET_VERSION)
    set_meta(conn, "reset_at", utcnow())

    scenario_counts = {}
    for l in labels:
        if l["scenario_id"] != "background":
            scenario_counts[l["scenario_id"]] = scenario_counts.get(l["scenario_id"], 0) + 1
    scenarios = [
        {**{k: s[k] for k in ("scenario_id", "label", "title")}, "transaction_count": scenario_counts.get(s["scenario_id"], 0)}
        for s in synthetic_data.SCENARIOS
    ]
    summary = {
        "dataset_version": DATASET_VERSION,
        "accounts": len(accounts),
        "transactions": len(transactions),
        "scenarios": scenarios,
    }
    audit.record(conn, "DEMO_RESET", audit.ACTOR_SYSTEM, {"dataset_version": DATASET_VERSION,
                                                          "transactions": len(transactions)})
    return summary


def is_loaded(conn: sqlite3.Connection) -> bool:
    try:
        return conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] > 0
    except sqlite3.OperationalError:
        return False
