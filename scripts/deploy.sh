#!/usr/bin/env bash
# Deploy FraudGraph AI to Google Cloud: Cloud Run + Vertex AI (Gemini) + Cloud Storage + BigQuery (+ BigQuery ML)
# + Pub/Sub + Document AI + Vertex AI Search. Safe to re-run: every step creates only what is missing.
#
#   bash scripts/deploy.sh <PROJECT_ID> [REGION]
#
# Runs in Google Cloud Shell or in WSL with the Google Cloud CLI signed in (gcloud auth login).
# Options (environment variables):
#   ADMIN_TOKEN=...         protects restore-baseline, the simulator write endpoints and model training
#   GEMINI_API_KEY=...      use an AI Studio key instead of Vertex AI
#   SKIP_SEARCH=1           skip Vertex AI Search (policy library)
#   SKIP_DOCAI=1            skip Document AI
#   BUDGET_USD=50           budget alert amount on the billing account (0 to skip)
set -euo pipefail
export PATH="$HOME/google-cloud-sdk/bin:$PATH"

PROJECT_ID="${1:?Usage: bash scripts/deploy.sh <PROJECT_ID> [REGION]}"
REGION="${2:-us-central1}"
SERVICE="${SERVICE:-fraudgraph-ai}"
SA_NAME="${SERVICE}-run"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
FALLBACKS="${GEMINI_FALLBACK_MODELS:-gemini-flash-latest,gemini-3.1-flash-lite,gemini-flash-lite-latest}"
BUCKET="${PROJECT_ID}-fraudgraph"
BQ_DATASET="fraudgraph"
BQ_LOCATION="US"
TOPIC="fraudgraph-transfers"
SUBSCRIPTION="fraudgraph-transfers-push"
DOCAI_LOCATION="us"
DOCAI_NAME="fraudgraph-invoices"
DATASTORE="fraudgraph-policies"
ENGINE="fraudgraph-policy-search"
BUDGET_USD="${BUDGET_USD:-50}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
gcloud config set project "$PROJECT_ID" >/dev/null
export CLOUDSDK_CORE_DISABLE_PROMPTS=1  # never block on a Y/n prompt (e.g. creating the image repository)
TOKEN() { gcloud auth print-access-token; }
api() {  # api METHOD URL [JSON]
  curl -sS -X "$1" "$2" -H "Authorization: Bearer $(TOKEN)" -H "Content-Type: application/json" \
    -H "X-Goog-User-Project: $PROJECT_ID" ${3:+-d "$3"}
}
secret() {  # secret NAME VALUE
  printf '%s' "$2" | gcloud secrets create "$1" --data-file=- >/dev/null 2>&1 || \
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$SA_EMAIL" \
    --role roles/secretmanager.secretAccessor --quiet >/dev/null
}

echo "==> [1/9] Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com secretmanager.googleapis.com storage.googleapis.com bigquery.googleapis.com \
  pubsub.googleapis.com documentai.googleapis.com discoveryengine.googleapis.com iam.googleapis.com \
  billingbudgets.googleapis.com cloudbilling.googleapis.com

echo "==> [2/9] Service account $SA_EMAIL (least privilege)"
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --display-name "FraudGraph AI (Cloud Run)"
for role in roles/aiplatform.user roles/logging.logWriter roles/bigquery.jobUser roles/documentai.apiUser \
            roles/discoveryengine.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA_EMAIL" --role "$role" \
    --condition=None --quiet >/dev/null
done

# New projects: `run deploy --source` builds with the default compute service account, which starts with no roles.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/cloudbuild.builds.builder roles/run.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$BUILD_SA" --role "$role" \
    --condition=None --quiet >/dev/null 2>&1 || true
done

echo "==> [3/9] Cloud Storage bucket gs://$BUCKET (state snapshot + policy library)"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access \
    --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA_EMAIL" \
  --role roles/storage.objectAdmin >/dev/null
gcloud storage cp policies/*.html "gs://$BUCKET/policies/" >/dev/null

echo "==> [4/9] BigQuery dataset $BQ_DATASET ($BQ_LOCATION)"
bq --location="$BQ_LOCATION" show "$PROJECT_ID:$BQ_DATASET" >/dev/null 2>&1 || \
  bq --location="$BQ_LOCATION" mk -d --description "FraudGraph AI analytics mirror (synthetic data)" "$PROJECT_ID:$BQ_DATASET"
# Dataset-level editor (not project-wide): the app may only write its own mirror.
bq show --format=prettyjson "$PROJECT_ID:$BQ_DATASET" > /tmp/fg_ds.json
if ! grep -q "$SA_EMAIL" /tmp/fg_ds.json; then
  python3 - "$SA_EMAIL" <<'PY'
import json, sys
d = json.load(open("/tmp/fg_ds.json"))
d.setdefault("access", []).append({"role": "WRITER", "userByEmail": sys.argv[1]})
json.dump(d, open("/tmp/fg_ds.json", "w"))
PY
  bq update --source /tmp/fg_ds.json "$PROJECT_ID:$BQ_DATASET" >/dev/null
fi

echo "==> [5/9] Pub/Sub topic $TOPIC"
gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 || gcloud pubsub topics create "$TOPIC"
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --member "serviceAccount:$SA_EMAIL" \
  --role roles/pubsub.publisher >/dev/null

DOCAI_PROCESSOR=""
if [ -z "${SKIP_DOCAI:-}" ]; then
  echo "==> [6/9] Document AI invoice processor ($DOCAI_LOCATION)"
  DOCAI_BASE="https://${DOCAI_LOCATION}-documentai.googleapis.com/v1/projects/${PROJECT_ID}/locations/${DOCAI_LOCATION}"
  DOCAI_PROCESSOR="$(api GET "$DOCAI_BASE/processors" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(next((p['name'] for p in d.get('processors',[]) if p.get('displayName')=='$DOCAI_NAME'),''))")"
  if [ -z "$DOCAI_PROCESSOR" ]; then
    DOCAI_PROCESSOR="$(api POST "$DOCAI_BASE/processors" "{\"type\":\"INVOICE_PROCESSOR\",\"displayName\":\"$DOCAI_NAME\"}" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('name') or ''); (not d.get('name')) and print(d, file=sys.stderr)")"
  fi
  echo "    processor: ${DOCAI_PROCESSOR:-<not created>}"
fi

SERVING_CONFIG=""
if [ -z "${SKIP_SEARCH:-}" ]; then
  echo "==> [7/9] Vertex AI Search data store + search app (policy library)"
  DE="https://discoveryengine.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/collections/default_collection"
  if ! api GET "$DE/dataStores/$DATASTORE" | grep -q "\"name\""; then
    api POST "$DE/dataStores?dataStoreId=$DATASTORE" \
      '{"displayName":"FraudGraph policy library","industryVertical":"GENERIC","solutionTypes":["SOLUTION_TYPE_SEARCH"],"contentConfig":"CONTENT_REQUIRED"}' >/dev/null
    sleep 15
  fi
  api POST "$DE/dataStores/$DATASTORE/branches/0/documents:import" \
    "{\"gcsSource\":{\"inputUris\":[\"gs://$BUCKET/policies/*\"],\"dataSchema\":\"content\"},\"reconciliationMode\":\"FULL\"}" >/dev/null
  if ! api GET "$DE/engines/$ENGINE" | grep -q "\"name\""; then
    api POST "$DE/engines?engineId=$ENGINE" \
      "{\"displayName\":\"FraudGraph policy search\",\"dataStoreIds\":[\"$DATASTORE\"],\"solutionType\":\"SOLUTION_TYPE_SEARCH\",\"searchEngineConfig\":{\"searchTier\":\"SEARCH_TIER_ENTERPRISE\",\"searchAddOns\":[\"SEARCH_ADD_ON_LLM\"]}}" >/dev/null
  fi
  SERVING_CONFIG="projects/${PROJECT_ID}/locations/global/collections/default_collection/engines/${ENGINE}/servingConfigs/default_search"
  echo "    serving config: $SERVING_CONFIG (indexing can take 5-15 minutes)"
fi

echo "==> [8/9] Secrets and Cloud Run deployment ($REGION)"
PUSH_TOKEN="$(gcloud secrets versions access latest --secret fraudgraph-push-token 2>/dev/null || python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
secret fraudgraph-push-token "$PUSH_TOKEN"
SECRET_FLAGS=(--set-secrets "PUBSUB_PUSH_TOKEN=fraudgraph-push-token:latest")
ENV_VARS="^@^GEMINI_MODEL=${MODEL}@GEMINI_FALLBACK_MODELS=${FALLBACKS}@GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
ENV_VARS+="@GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION:-global}@GCS_STATE_BUCKET=${BUCKET}"
ENV_VARS+="@BIGQUERY_DATASET=${BQ_DATASET}@BIGQUERY_LOCATION=${BQ_LOCATION}@PUBSUB_TOPIC=${TOPIC}"
[ -n "$DOCAI_PROCESSOR" ] && ENV_VARS+="@DOCAI_PROCESSOR=${DOCAI_PROCESSOR}"
[ -n "$SERVING_CONFIG" ] && ENV_VARS+="@VERTEX_SEARCH_SERVING_CONFIG=${SERVING_CONFIG}"
if [ -n "${GEMINI_API_KEY:-}" ]; then
  secret gemini-api-key "$GEMINI_API_KEY"
  SECRET_FLAGS+=(--set-secrets "GEMINI_API_KEY=gemini-api-key:latest")
  ENV_VARS+="@GEMINI_BACKEND=api_key"
else
  ENV_VARS+="@GEMINI_BACKEND=vertex"
fi
if [ -n "${ADMIN_TOKEN:-}" ]; then
  secret fraudgraph-admin-token "$ADMIN_TOKEN"
  SECRET_FLAGS+=(--set-secrets "DEMO_TOKEN=fraudgraph-admin-token:latest")
fi

# --no-cpu-throttling keeps CPU for the background state backup and BigQuery sync after a response is sent.
# --max-instances 1: SQLite is the system of record, and it keeps spend predictable on the trial credit.
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated --quiet \
  --service-account "$SA_EMAIL" --max-instances 1 --min-instances 0 --memory 1Gi --cpu 1 --timeout 300 \
  --no-cpu-throttling --set-env-vars "$ENV_VARS" "${SECRET_FLAGS[@]}"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"

echo "==> [9/9] Pub/Sub push subscription -> $URL"
PUSH_URL="$URL/api/cloud/stream/push?token=$PUSH_TOKEN"
if gcloud pubsub subscriptions describe "$SUBSCRIPTION" >/dev/null 2>&1; then
  gcloud pubsub subscriptions modify-push-config "$SUBSCRIPTION" --push-endpoint "$PUSH_URL" >/dev/null
else
  gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic "$TOPIC" --push-endpoint "$PUSH_URL" \
    --ack-deadline 60 --min-retry-delay 5s --max-retry-delay 60s >/dev/null
fi

if [ "$BUDGET_USD" != "0" ]; then
  BILLING="$(gcloud billing projects describe "$PROJECT_ID" --format 'value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##')"
  # The budget must be in the billing account's own currency (a trial account in India bills in INR).
  CURRENCY="$(gcloud billing accounts describe "$BILLING" --format 'value(currencyCode)' 2>/dev/null || echo USD)"
  BUDGET_AMOUNT="$BUDGET_USD"
  [ "$CURRENCY" = "INR" ] && BUDGET_AMOUNT=$((BUDGET_USD * 80))
  if [ -n "$BILLING" ] && ! gcloud billing budgets list --billing-account "$BILLING" --format 'value(displayName)' 2>/dev/null | grep -q fraudgraph; then
    gcloud billing budgets create --billing-account "$BILLING" --display-name "fraudgraph-budget" \
      --budget-amount "${BUDGET_AMOUNT}${CURRENCY}" --threshold-rule percent=0.5 --threshold-rule percent=0.9 >/dev/null \
      && echo "    Budget alert: ${BUDGET_USD} USD" || echo "    (Budget alert skipped: set one in the console)"
  fi
fi

echo "==> Training the BigQuery ML model (runs in the background on the service, 2-5 minutes)"
curl -sS -X POST "$URL/api/cloud/ml/train" ${ADMIN_TOKEN:+-H "X-Demo-Token: $ADMIN_TOKEN"} || true
echo
echo "==> Deployed: $URL"
echo "    Health:        $URL/api/health"
echo "    AI status:     $URL/api/ai/status?refresh=true"
echo "    Cloud status:  $URL/api/cloud/status"
