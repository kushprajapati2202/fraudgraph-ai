# Deploying to Google Cloud Run

The app ships as one container: FastAPI serves both the API and the built React UI. `scripts/deploy.sh` does the whole deployment.

## What the script sets up

| Google Cloud service | Used for |
|---|---|
| **Cloud Run** | Runs the container on a public HTTPS URL, scaling to zero when idle |
| **Cloud Build** and **Artifact Registry** | Build the image from the Dockerfile and store it |
| **Vertex AI (Gemini)** | Investigation summaries, follow-up answers, escalation reports and document reading |
| **IAM service account** | A dedicated least-privilege identity (`roles/aiplatform.user`, `roles/logging.logWriter`) |
| **Secret Manager** | Holds the admin token, and the Gemini API key if you choose key mode |
| **Cloud Logging** | The app writes one JSON log line per request with a request ID and severity |

In the default mode the app calls Gemini through **Vertex AI using the service account**. There is no API key to store, rotate or leak.

## Steps (Google Cloud Shell, nothing to install)

1. Open https://shell.cloud.google.com and select your project. Billing must be enabled on it.
2. Get the code into Cloud Shell: either `git clone <your repo>`, or use the editor's **Upload** to upload a zip and `unzip` it.
3. Run:
   ```bash
   cd FraudGraphAI
   ADMIN_TOKEN='choose-a-long-random-token' bash scripts/deploy.sh <PROJECT_ID> asia-south1
   ```
   The first deployment takes about 5 to 8 minutes. The script prints the service URL at the end.
4. Check it:
   - Open `<URL>/api/ai/status?refresh=true`. It should show `"state": "CONNECTED"` and `"backend": "Vertex AI"`.
   - From Windows, run `.\scripts\windows\fg.ps1 smoke -BaseUrl <URL> -DemoToken <your token>`.
   - Open the URL in a browser and take the tour.

## Options

| Setting | How | Default |
|---|---|---|
| Use an AI Studio key instead of Vertex AI | `GEMINI_API_KEY=... bash scripts/deploy.sh <PROJECT_ID>` (stored in Secret Manager) | Vertex AI |
| Vertex AI location | `VERTEX_LOCATION=us-central1` | `global` |
| Models | `GEMINI_MODEL=...`, `GEMINI_FALLBACK_MODELS=a,b,c` | `gemini-3.8-flash` then three fallbacks |
| Admin token | `ADMIN_TOKEN=...` protects **Restore baseline** and the simulator's write endpoint | none (open) |
| Service name | `SERVICE=...` | `fraudgraph-ai` |

## Things to know

- **Vertex AI mode has not been run yet.** It was written against the `google-genai` SDK's documented Vertex options, but this project has only been tested with an AI Studio key. Check `/api/ai/status` right after deploying. If a model name is not available on Vertex AI in your region, set `GEMINI_MODEL` to one that is, or redeploy in key mode.
- **State is temporary.** The database is SQLite in `/tmp`, and the service runs with `--max-instances 1`. When Cloud Run restarts the container, the app reloads the baseline dataset and re-runs analysis. Decisions and uploads made before the restart are gone. For durable state, replace `backend/db.py` with Firestore or Cloud SQL.
- **Cost.** The service scales to zero. Set a budget alert on the project anyway, because Gemini calls are billed per use and the URL is public.
- **Uploaded documents are not stored.** Only a SHA-256 hash, the extracted fields and the check results are kept.

## Redeploy and remove

- Redeploy after a code change: run the same `bash scripts/deploy.sh ...` command again.
- Remove the service: `gcloud run services delete fraudgraph-ai --region <REGION>`.
