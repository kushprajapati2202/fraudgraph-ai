#!/usr/bin/env bash
# Deploy FraudGraph AI to Google Cloud Run.
#
# Easiest place to run this: Google Cloud Shell (https://shell.cloud.google.com), where gcloud is preinstalled
# and already signed in. Upload or git-clone the repo there, then:
#
#   bash scripts/deploy.sh <PROJECT_ID> [REGION]
#
# Default mode uses Gemini on Vertex AI with the Cloud Run service account (no API key to store).
# To use an AI Studio key instead:  GEMINI_API_KEY=... bash scripts/deploy.sh <PROJECT_ID> [REGION]
# Optional: ADMIN_TOKEN=... protects "Restore baseline" and the simulator's write endpoint.
set -euo pipefail

PROJECT_ID="${1:?Usage: bash scripts/deploy.sh <PROJECT_ID> [REGION]}"
REGION="${2:-asia-south1}"
SERVICE="${SERVICE:-fraudgraph-ai}"
SA_NAME="${SERVICE}-run"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
FALLBACKS="${GEMINI_FALLBACK_MODELS:-gemini-flash-latest,gemini-3.1-flash-lite,gemini-flash-lite-latest}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "==> Project $PROJECT_ID, region $REGION, service $SERVICE"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling APIs (Cloud Run, Cloud Build, Artifact Registry, Vertex AI, Secret Manager)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com secretmanager.googleapis.com

echo "==> Service account $SA_EMAIL (least privilege: Vertex AI user, log writer)"
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --display-name "FraudGraph AI (Cloud Run)"
for role in roles/aiplatform.user roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA_EMAIL" --role "$role" \
    --condition=None --quiet >/dev/null
done

# Comma-separated env values need a custom delimiter (^@^) because the fallback list itself contains commas.
ENV_VARS="^@^GEMINI_MODEL=${MODEL}@GEMINI_FALLBACK_MODELS=${FALLBACKS}@GOOGLE_CLOUD_PROJECT=${PROJECT_ID}@GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION:-global}"
SECRET_FLAGS=()

if [ -n "${GEMINI_API_KEY:-}" ]; then
  echo "==> Storing the Gemini API key in Secret Manager (mode: Gemini API key)"
  printf '%s' "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=- 2>/dev/null || \
    printf '%s' "$GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=-
  gcloud secrets add-iam-policy-binding gemini-api-key --member "serviceAccount:$SA_EMAIL" \
    --role roles/secretmanager.secretAccessor --quiet >/dev/null
  SECRET_FLAGS+=(--set-secrets "GEMINI_API_KEY=gemini-api-key:latest")
  ENV_VARS="${ENV_VARS}@GEMINI_BACKEND=api_key"
else
  echo "==> Mode: Vertex AI with the service account (no API key)"
  ENV_VARS="${ENV_VARS}@GEMINI_BACKEND=vertex"
fi

if [ -n "${ADMIN_TOKEN:-}" ]; then
  printf '%s' "$ADMIN_TOKEN" | gcloud secrets create fraudgraph-admin-token --data-file=- 2>/dev/null || \
    printf '%s' "$ADMIN_TOKEN" | gcloud secrets versions add fraudgraph-admin-token --data-file=-
  gcloud secrets add-iam-policy-binding fraudgraph-admin-token --member "serviceAccount:$SA_EMAIL" \
    --role roles/secretmanager.secretAccessor --quiet >/dev/null
  SECRET_FLAGS+=(--set-secrets "DEMO_TOKEN=fraudgraph-admin-token:latest")
fi

echo "==> Building with Cloud Build and deploying to Cloud Run"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --service-account "$SA_EMAIL" --max-instances 1 --min-instances 0 --memory 1Gi --cpu 1 --timeout 300 \
  --set-env-vars "$ENV_VARS" "${SECRET_FLAGS[@]}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
echo
echo "==> Deployed: $URL"
echo "    Health:    $URL/api/health"
echo "    AI status: $URL/api/ai/status?refresh=true"
echo "    Smoke test from Windows: .\\scripts\\windows\\fg.ps1 smoke -BaseUrl $URL"
