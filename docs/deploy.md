# Deploying to Google Cloud

The app ships as one container on Cloud Run: FastAPI serves the API and the built React UI. `scripts/deploy.sh` creates everything else it needs and is safe to re-run.

## What the script sets up

| Google Cloud service | Used for |
|---|---|
| **Cloud Run** | The service on a public HTTPS URL; scales to zero when idle |
| **Cloud Build**, **Artifact Registry** | Build the image from the Dockerfile and store it |
| **Vertex AI (Gemini)** | Investigation, chat, reports, document reading, briefings, SQL writing, policy guidance, red team |
| **Cloud Storage** | SQLite snapshot (state survives restarts) and the policy library source files |
| **BigQuery** | Analytics mirror of transfers, cases, decisions and controls; *Ask BigQuery* |
| **BigQuery ML** | Boosted-tree model with `ML.EXPLAIN_PREDICT` attributions as a second view next to the rules |
| **Pub/Sub** | Event-driven ingest: transfers published to a topic, pushed to Cloud Run, scored on arrival |
| **Document AI** | Invoice parser as an independent second reader of supporting documents |
| **Vertex AI Search** | Retrieval over the financial-crime policy library (`policies/`) |
| **Secret Manager**, **IAM** | Push token and admin token; a least-privilege service account |
| **Cloud Logging** | One JSON log line per request with a request ID |
| **Cloud Billing budgets** | A budget alert on the billing account (default 50 USD) |

## Steps

From WSL (with the Google Cloud CLI signed in) or from Google Cloud Shell:

```bash
gcloud auth login                     # once
ADMIN_TOKEN='choose-a-long-random-token' bash scripts/deploy.sh <PROJECT_ID>      # region defaults to us-central1
```

The first run takes about 8–12 minutes. At the end the script prints the URL and starts BigQuery ML training (2–5 minutes, in the background on the service).

Check it:
- `<URL>/api/ai/status?refresh=true` shows `"state": "CONNECTED"` and `"backend": "Vertex AI"`.
- `<URL>/api/cloud/status` lists every service as enabled.
- Settings › Google Cloud shows the services, the last state save and BigQuery sync, and the model's evaluation.
- Vertex AI Search indexes the policy library in 5–15 minutes; until then *What our policy says* may return no passages.

## Why us-central1

On a free-trial account it is the safest choice: every service used here is available there, new Gemini models usually reach it first, and Cloud Run tier-1 pricing applies. BigQuery uses the `US` multi-region, Document AI the `us` location, and Gemini the Vertex AI `global` endpoint.

## Options

| Setting | How | Default |
|---|---|---|
| Region | second argument | `us-central1` |
| AI Studio key instead of Vertex AI | `GEMINI_API_KEY=...` | Vertex AI |
| Models | `GEMINI_MODEL=...`, `GEMINI_FALLBACK_MODELS=a,b,c` | `gemini-3.8-flash` then fallbacks |
| Skip Vertex AI Search / Document AI | `SKIP_SEARCH=1`, `SKIP_DOCAI=1` | both on |
| Budget alert | `BUDGET_USD=...` (`0` to skip) | 50 |

## Cost and safety on the trial credit

- `--max-instances 1` and `--min-instances 0`: at most one instance, none when idle.
- `--no-cpu-throttling` keeps CPU after a response so the state save and BigQuery sync can finish; with min-instances 0 the instance still stops when idle.
- BigQuery: load jobs are free; every *Ask BigQuery* query is capped at 200 MB billed and the whole mirror is under 1 MB.
- The service account can write only its own bucket and BigQuery dataset, publish only to its topic, and read (not change) the search engine.
- The admin token protects restore-baseline, the simulator write endpoints, the BigQuery sync and model training.

## How state works

SQLite in `/tmp` is the system of record, with one instance. After each change a consistent copy (SQLite backup API) is uploaded to `gs://<project>-fraudgraph/state/fraudgraph.db`; on start the service restores it. BigQuery holds a read-only mirror refreshed 15 seconds after changes. To scale beyond one instance, move `backend/db.py` to Cloud SQL for PostgreSQL; the analytics, ML and stream paths do not change.

## Redeploy and remove

- Redeploy after a code change: run the same command again.
- Remove: `gcloud run services delete fraudgraph-ai --region us-central1`, then delete the bucket, the `fraudgraph` dataset, the topic and subscription, the Document AI processor and the search app in the console.
