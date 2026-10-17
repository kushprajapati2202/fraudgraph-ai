"""BigQuery ML: a boosted-tree model trained on behavioural features, scored next to the rule engine.

The rules stay the primary, explainable score. The model is a second, independent view: it learns from raw
behaviour (velocity, fan-in, onward movement, account age, device sharing) rather than from the rule outputs, and
ML.EXPLAIN_PREDICT returns the top feature attributions for every transfer. Scores are copied back into SQLite
(`ml_scores`) so the app never queries BigQuery on a page load. Labels are synthetic scenario labels, so the
evaluation shows the technique working, not real-world accuracy.
"""
import json
import logging
import threading

from backend.config import settings
from backend.db import connect, dumps, get_meta, set_meta, utcnow
from backend.services import bigquery_sync

logger = logging.getLogger("fraudgraph.bigquery_ml")

MODEL = "mule_risk_model"
FEATURE_LABELS = {
    "amount": "Amount", "log_amount": "Amount (log scale)", "channel": "Channel", "hour_of_day": "Hour of day",
    "sender_account_age_days": "Sender account age", "receiver_account_age_days": "Receiver account age",
    "sender_kyc": "Sender KYC tier", "receiver_kyc": "Receiver KYC tier",
    "sender_transfers_2h": "Sender transfers within ±1 h", "sender_inbound_1h": "Inbound to sender in prior hour",
    "sender_distinct_payers_1h": "Distinct payers to sender in prior hour",
    "receiver_onward_ratio_30m": "Share moved on by receiver within 30 min",
    "prior_pair_transfers": "Earlier transfers on this pair", "sender_prior_transfers": "Sender's earlier transfers",
    "amount_vs_sender_avg": "Amount vs sender's average", "device_account_count": "Accounts sharing the device",
}

_lock = threading.Lock()
status: dict = {"state": "NOT_TRAINED", "error": None, "trained_at": None, "metrics": None,
                "global_explain": None, "scored": 0, "scored_at": None}


def enabled() -> bool:
    return bigquery_sync.enabled()


def _ds() -> str:
    return bigquery_sync.dataset_ref()


def features_sql() -> str:
    ds = _ds()
    return f"""
CREATE OR REPLACE VIEW `{ds}.ml_features` AS
WITH t AS (
  SELECT transaction_id, source_account, destination_account, amount, ts, channel, device_id, UNIX_SECONDS(ts) AS s
  FROM `{ds}.transfers`),
velocity AS (
  SELECT a.transaction_id, COUNT(b.transaction_id) AS sender_transfers_2h
  FROM t a LEFT JOIN t b ON b.source_account = a.source_account AND b.s BETWEEN a.s - 3600 AND a.s + 3600
  GROUP BY a.transaction_id),
inbound AS (
  SELECT a.transaction_id, COUNT(b.transaction_id) AS sender_inbound_1h,
         COUNT(DISTINCT b.source_account) AS sender_distinct_payers_1h
  FROM t a LEFT JOIN t b ON b.destination_account = a.source_account AND b.s BETWEEN a.s - 3600 AND a.s
  GROUP BY a.transaction_id),
onward AS (
  SELECT a.transaction_id, SAFE_DIVIDE(COALESCE(SUM(b.amount), 0), ANY_VALUE(a.amount)) AS receiver_onward_ratio_30m
  FROM t a LEFT JOIN t b ON b.source_account = a.destination_account AND b.s BETWEEN a.s AND a.s + 1800
  GROUP BY a.transaction_id),
history AS (
  SELECT a.transaction_id, COUNTIF(b.destination_account = a.destination_account) AS prior_pair_transfers,
         COUNT(b.transaction_id) AS sender_prior_transfers, AVG(b.amount) AS sender_prior_avg
  FROM t a LEFT JOIN t b ON b.source_account = a.source_account AND b.s < a.s
  GROUP BY a.transaction_id),
devices AS (
  SELECT device_id, COUNT(DISTINCT source_account) AS device_account_count
  FROM t WHERE device_id IS NOT NULL GROUP BY device_id)
SELECT
  t.transaction_id, t.amount, LOG10(t.amount + 1) AS log_amount, t.channel, EXTRACT(HOUR FROM t.ts) AS hour_of_day,
  DATE_DIFF(DATE(t.ts), sa.opened_on, DAY) AS sender_account_age_days,
  DATE_DIFF(DATE(t.ts), da.opened_on, DAY) AS receiver_account_age_days,
  sa.kyc_tier AS sender_kyc, da.kyc_tier AS receiver_kyc,
  v.sender_transfers_2h, i.sender_inbound_1h, i.sender_distinct_payers_1h,
  COALESCE(o.receiver_onward_ratio_30m, 0) AS receiver_onward_ratio_30m,
  h.prior_pair_transfers, h.sender_prior_transfers,
  COALESCE(SAFE_DIVIDE(t.amount, h.sender_prior_avg), 1) AS amount_vs_sender_avg,
  COALESCE(d.device_account_count, 1) AS device_account_count,
  l.label
FROM t
JOIN velocity v USING (transaction_id)
JOIN inbound i USING (transaction_id)
JOIN onward o USING (transaction_id)
JOIN history h USING (transaction_id)
LEFT JOIN devices d ON d.device_id = t.device_id
LEFT JOIN `{ds}.accounts` sa ON sa.account_id = t.source_account
LEFT JOIN `{ds}.accounts` da ON da.account_id = t.destination_account
LEFT JOIN `{ds}.labels` l ON l.transaction_id = t.transaction_id"""


def train_sql() -> str:
    ds = _ds()
    return f"""
CREATE OR REPLACE MODEL `{ds}.{MODEL}`
OPTIONS(model_type = 'BOOSTED_TREE_CLASSIFIER', input_label_cols = ['is_suspicious'], auto_class_weights = TRUE,
        data_split_method = 'RANDOM', data_split_eval_fraction = 0.3, max_iterations = 40,
        enable_global_explain = TRUE) AS
SELECT * EXCEPT (transaction_id, label), label = 'SUSPICIOUS' AS is_suspicious
FROM `{ds}.ml_features`
WHERE label IN ('SUSPICIOUS', 'LEGIT')"""


def score_sql() -> str:
    ds = _ds()
    return f"""
SELECT transaction_id,
       IF(predicted_is_suspicious, probability, 1 - probability) AS p_suspicious,
       ARRAY(SELECT AS STRUCT feature, attribution FROM UNNEST(top_feature_attributions)
             ORDER BY ABS(attribution) DESC) AS top_features
FROM ML.EXPLAIN_PREDICT(MODEL `{ds}.{MODEL}`, (SELECT * EXCEPT (label) FROM `{ds}.ml_features`),
                        STRUCT(4 AS top_k_features))"""


def _query(sql: str, timeout: float = 600):
    return list(bigquery_sync.client().query(sql).result(timeout=timeout))


def _load_info() -> None:
    """Read evaluation metrics and global feature importance of the trained model."""
    ds = _ds()
    ev = _query(f"SELECT * FROM ML.EVALUATE(MODEL `{ds}.{MODEL}`)")
    metrics = {k: (round(float(v), 4) if v is not None else None) for k, v in dict(ev[0]).items()} if ev else None
    ge = _query(f"SELECT feature, attribution FROM ML.GLOBAL_EXPLAIN(MODEL `{ds}.{MODEL}`) ORDER BY attribution DESC LIMIT 8")
    model = bigquery_sync.client().get_model(f"{ds}.{MODEL}")
    status.update(state="TRAINED", metrics=metrics, error=None,
                  trained_at=model.created.isoformat() if model.created else None,
                  global_explain=[{"feature": r["feature"], "label": FEATURE_LABELS.get(r["feature"], r["feature"]),
                                   "attribution": round(float(r["attribution"]), 4)} for r in ge])


def train() -> dict:
    """Sync data, (re)create the feature view, train, evaluate and score. Blocking; run it in a thread."""
    if not enabled():
        return status
    with _lock:
        status.update(state="TRAINING", error=None)
        try:
            bigquery_sync.sync_now()
            _query(features_sql())
            _query(train_sql(), timeout=1200)
            _load_info()
        except Exception as exc:
            status.update(state="FAILED", error=f"{type(exc).__name__}: {str(exc)[:300]}")
            logger.warning("BigQuery ML training failed: %s", exc)
            return status
    score()
    return status


def train_async() -> None:
    threading.Thread(target=train, daemon=True).start()


def model_exists() -> bool:
    try:
        bigquery_sync.client().get_model(f"{_ds()}.{MODEL}")
        return True
    except Exception:
        return False


def score() -> int:
    """Score every transfer with the trained model and copy the results into SQLite."""
    try:
        _query(features_sql())  # the view may predate new columns; recreating it is free
        rows = _query(score_sql())
    except Exception as exc:
        status["error"] = f"score: {type(exc).__name__}: {str(exc)[:200]}"
        logger.warning("BigQuery ML scoring failed: %s", exc)
        return 0
    now = utcnow()
    with connect() as conn:
        conn.execute("DELETE FROM ml_scores")
        conn.executemany(
            "INSERT INTO ml_scores(transaction_id, probability, top_features_json, model, scored_at) VALUES (?, ?, ?, ?, ?)",
            [(r["transaction_id"], round(float(r["p_suspicious"]), 4),
              dumps([{"feature": f["feature"], "attribution": round(float(f["attribution"]), 4)} for f in r["top_features"]]),
              MODEL, now) for r in rows])
        set_meta(conn, "ml_scored_at", now)
    status.update(scored=len(rows), scored_at=now)
    return len(rows)


def score_if_trained() -> None:
    if not enabled() or status["state"] == "TRAINING":
        return  # training scores everything itself when it finishes
    if status["state"] in ("NOT_TRAINED", "FAILED") and not model_exists():
        return
    if status["state"] != "TRAINED":
        try:
            _load_info()
        except Exception as exc:
            status["error"] = f"info: {type(exc).__name__}"
    score()


def info() -> dict:
    with connect() as conn:
        scored = conn.execute("SELECT COUNT(*) FROM ml_scores").fetchone()[0]
        scored_at = get_meta(conn, "ml_scored_at")
    return {**status, "scored": scored, "scored_at": scored_at, "model": f"{settings.bigquery_dataset}.{MODEL}"
            if enabled() else None, "feature_labels": FEATURE_LABELS}


def for_transactions(conn, tx_ids: list[str]) -> dict[str, dict]:
    if not tx_ids:
        return {}
    marks = ",".join("?" * len(tx_ids))
    out = {}
    for r in conn.execute(f"SELECT * FROM ml_scores WHERE transaction_id IN ({marks})", tx_ids):
        feats = json.loads(r["top_features_json"])
        out[r["transaction_id"]] = {
            "probability": r["probability"], "model": r["model"], "scored_at": r["scored_at"],
            "top_features": [{**f, "label": FEATURE_LABELS.get(f["feature"], f["feature"])} for f in feats]}
    return out
