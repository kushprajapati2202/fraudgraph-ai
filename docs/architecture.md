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
   |-- prompts/system_v1.txt
   v
SQLite (DB_PATH; /tmp on Cloud Run)         Gemini API (google-genai SDK; key from Secret Manager)
```

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
SQLite keeps setup to zero. On Cloud Run it runs with `--max-instances=1`, and the database lives in `/tmp`, which is ephemeral by design. Startup and `POST /api/demo/reset` restore the identical ds-v1 baseline. If you need durable state across restarts, replace `backend/db.py` with Firestore.

## Security notes
- All SQL uses bound parameters. Sort columns come from an allow-list, and LIKE wildcards are escaped.
- When `DEMO_TOKEN` is set, `POST /api/demo/reset` and `POST /api/transactions/demo` require `X-Demo-Token`.
- Errors use the `{"error": {code, message, details}}` envelope. Unhandled errors return a request ID and no stack trace.
- `/api/health` reports only whether Gemini is configured, never the key.
