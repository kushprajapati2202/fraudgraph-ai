# Architecture

```
Browser (React + TypeScript + Vite, Cytoscape.js)
   |  JSON over HTTPS, /api/*
   v
FastAPI (backend/main.py)  - Pydantic validation, error envelope, request IDs, SPA hosting
   |-- api/            routes: health, dashboard, demo, transactions, analysis, graph, cases
   |-- services/
   |     synthetic_data.py  deterministic fictional dataset (seed 2026)
   |     dataset.py         reset: load CSVs -> SQLite
   |     risk_engine.py     pure rule functions -> score, band, signals, uncertainties (rules-v1)
   |     graph_engine.py    NetworkX MultiDiGraph, time-respecting paths, graph payloads
   |     investigation.py   case building (union-find) + evidence objects with stable IDs
   |     analysis.py        orchestration: score -> cases -> evidence -> diff -> audit
   |     gemini_service.py  bounded evidence package -> Gemini JSON -> schema + citation validation
   |     audit.py           append-only audit events (SYSTEM / AI / HUMAN)
   |     state_sync.py      SQLite snapshot <-> Cloud Storage (restore on start, debounced save after writes)
   |     bigquery_sync.py   analytics mirror in BigQuery (free load jobs, 15 s after changes)
   |     bigquery_ask.py    Gemini writes GoogleSQL -> static guard -> BigQuery dry run -> capped execution
   |     bigquery_ml.py     feature view -> BOOSTED_TREE_CLASSIFIER -> ML.EXPLAIN_PREDICT -> ml_scores
   |     pubsub_stream.py   publish transfers; push handler is idempotent and scores on arrival
   |     docai.py           Document AI invoice parser as second reader; field-by-field agreement
   |     policy_search.py   Vertex AI Search passages POL-n -> Gemini guidance with citation allow-list
   |-- prompts/system_v1.txt
   v
SQLite (/tmp, snapshot in Cloud Storage)     Gemini on Vertex AI (service account, no key)
```

## Google Cloud data flow

```
            publish                push (token)              record + controls + rescore
Simulator ----------> Pub/Sub topic ----------> Cloud Run /api/cloud/stream/push ----------> SQLite
                                                     |                                       |
                                                     | 15 s debounce, load jobs              | after each write
                                                     v                                       v
                                         BigQuery dataset `fraudgraph`             Cloud Storage snapshot
                                           |-- transfers, cases, accounts, decisions, mitigation_actions, labels
                                           |-- ml_features (view) -> mule_risk_model (BQML) -> ML.EXPLAIN_PREDICT
                                           '-- Ask BigQuery: Gemini SQL, dry-run gated, 200 MB cap
Document upload -> Gemini (vision) ---+--> code compares the two readings --> verdict (lowered on disagreement)
                -> Document AI -------'
Case -> Vertex AI Search (policy library) -> passages POL-n -> Gemini steps citing POL-n (allow-list checked)
```

Every Google Cloud integration is optional and off until its setting is present, so local development and the 107 automated tests need no cloud account.

## Analysis flow
1. `POST /api/analysis/run` loads every transaction and scores each one with `risk_engine.assess_all`. The engine is pure, so the same input always gives the same output.
2. Transactions scoring at least 30 (MEDIUM or HIGH) are linked when they share an account within the time window. Each connected group becomes a case. The case ID is a hash of the case's earliest transaction, so it stays stable when later transfers are added.
3. For each case the backend builds evidence objects:
   - `EV-PATH-n`: time-respecting transfer chains.
   - `EV-SIG-<tx>-<RULE>`: rule findings.
   - `EV-<tx>`: source records.
   - `EV-BASE-<account>`: baselines.
4. Each run is compared with the previous one. The diff (new or updated cases, changed signals) is stored and returned, and the What-if page uses it.
5. Re-running analysis updates case scores and evidence but keeps `status` and analyst decisions.

## Gemini grounding pipeline
1. `gemini_service.build_package` selects at most 80 evidence objects for the case, ordered paths, then findings, then transactions, then baselines. Free-text descriptions are truncated and wrapped as `{"untrusted_text": ...}`.
2. The system instruction (`prompts/system_v1.txt`) restricts Gemini to the supplied evidence. It also bans guilt language, protected-characteristic reasoning, code and actions, and asks for alternative explanations and uncertainty.
3. The response uses `response_mime_type=application/json` with `response_schema=InvestigationResult`. The temperature is 0.2 and the request times out after 20 s.
4. The backend validates the response with Pydantic. If it doesn't validate, the backend retries once and then falls back. Every cited ID is checked against the IDs that were sent:
   - Unknown IDs are removed and listed in `validation.removed_ids`.
   - A fact or indicator left with no valid citation moves to `unsupported_claims`, which is shown separately and never as fact.
   - Inline `EV-...` mentions that aren't in the allow-list are replaced.
5. On a missing key, timeout or API error, the response is `{"status": "UNAVAILABLE", ...}`. The deterministic findings, graph and evidence are untouched.
6. Each AI call writes an `AI_*` audit event with the model, prompt version, status and the number of removed IDs. It never logs the key.

## Persistence
SQLite is the system of record and keeps local setup to zero. On Cloud Run it runs with `--max-instances=1` in `/tmp`; after every successful write request a consistent copy (SQLite online backup API) is uploaded to Cloud Storage two seconds after the last change, and on shutdown any pending change is flushed. On start the service restores the latest snapshot before checking the schema, so decisions, controls and documents survive restarts and redeploys. BigQuery is a read-only analytical copy, never written back. To run more than one instance, move `backend/db.py` to Cloud SQL for PostgreSQL.

## Security notes
- All SQL uses bound parameters. Sort columns come from an allow-list, and LIKE wildcards are escaped.
- When `DEMO_TOKEN` is set, `POST /api/demo/reset` and `POST /api/transactions/demo` require `X-Demo-Token`, as do Pub/Sub publishing, the BigQuery sync and model training.
- Gemini-written SQL runs only after a static guard (one read-only SELECT, allow-listed tables, no comments, DDL, DML or scripting) and a BigQuery dry run that checks the statement type, every referenced table and the bytes scanned; execution is capped by `maximum_bytes_billed`. If the dry run rejects a query, the error goes back to Gemini once for a repair. Numbers in the written answer must appear in the result rows.
- The Pub/Sub push endpoint requires a secret token, acknowledges malformed messages instead of retrying them forever, and is idempotent: the transfer ID is reserved at publish time, so a redelivery is recorded as a duplicate.
- Errors use the `{"error": {code, message, details}}` envelope. Unhandled errors return a request ID and no stack trace.
- `/api/health` reports only whether Gemini is configured, never the key.
