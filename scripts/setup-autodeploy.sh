#!/usr/bin/env bash
# Auto-deploy: create a Cloud Build trigger that tests, builds and deploys cloudbuild.yaml on every push to main.
# Run once, after scripts/deploy.sh has created the Cloud Run service. Safe to re-run.
#
#   bash scripts/setup-autodeploy.sh <PROJECT_ID> [REGION]
#
# One-time prerequisite: connect the GitHub repository to Cloud Build (installs the Cloud Build GitHub App):
#   https://console.cloud.google.com/cloud-build/triggers;region=global/connect?project=<PROJECT_ID>
# Options (environment variables): BRANCH (default main), SERVICE (default fraudgraph-ai).
set -euo pipefail
export PATH="$HOME/google-cloud-sdk/bin:$PATH"

PROJECT_ID="${1:?Usage: bash scripts/setup-autodeploy.sh <PROJECT_ID> [REGION]}"
REGION="${2:-us-central1}"
SERVICE="${SERVICE:-fraudgraph-ai}"
BRANCH="${BRANCH:-main}"
TRIGGER="${SERVICE}-${BRANCH}-deploy"
DEPLOY_SA="${SERVICE}-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
RUN_SA="${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com"

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# owner/name from the origin remote, e.g. https://github.com/owner/name.git or git@github.com:owner/name.git
REMOTE="$(git remote get-url origin)"
REPO_PATH="$(printf '%s' "$REMOTE" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
REPO_OWNER="${REPO_PATH%%/*}"
REPO_NAME="${REPO_PATH##*/}"

gcloud config set project "$PROJECT_ID" >/dev/null
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
retry() {  # a new service account takes a few seconds to reach IAM
  for i in 1 2 3 4 5 6; do "$@" >/dev/null 2>&1 && return 0; sleep 10; done
  "$@" >/dev/null
}

echo "==> [1/4] Checking the Cloud Run service $SERVICE ($REGION)"
gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)' >/dev/null 2>&1 || {
  echo "    Service not found: run scripts/deploy.sh $PROJECT_ID $REGION first."; exit 1; }
gcloud services enable cloudbuild.googleapis.com artifactregistry.googleapis.com >/dev/null

echo "==> [2/4] Image repository cloud-run-source-deploy ($REGION)"
gcloud artifacts repositories describe cloud-run-source-deploy --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create cloud-run-source-deploy --location "$REGION" --repository-format docker \
    --description "FraudGraph AI images"

echo "==> [3/4] Deployer service account $DEPLOY_SA (least privilege)"
gcloud iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "${SERVICE}-deployer" --display-name "FraudGraph AI (Cloud Build deploy)"
for role in roles/run.developer roles/artifactregistry.writer roles/logging.logWriter; do
  retry gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$DEPLOY_SA" --role "$role" \
    --condition=None --quiet
done
# Deploying a revision that runs as the app's service account needs actAs on that account only.
retry gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --member "serviceAccount:$DEPLOY_SA" \
  --role roles/iam.serviceAccountUser --quiet

echo "==> [4/4] Trigger $TRIGGER: push to $REPO_OWNER/$REPO_NAME@$BRANCH"
if gcloud builds triggers describe "$TRIGGER" >/dev/null 2>&1; then
  gcloud builds triggers delete "$TRIGGER" --quiet >/dev/null  # recreate so changed settings apply
fi
if ! gcloud builds triggers create github --name "$TRIGGER" \
    --repo-owner "$REPO_OWNER" --repo-name "$REPO_NAME" --branch-pattern "^${BRANCH}\$" \
    --build-config cloudbuild.yaml --service-account "projects/$PROJECT_ID/serviceAccounts/$DEPLOY_SA" \
    --substitutions "_REGION=$REGION,_SERVICE=$SERVICE" \
    --ignored-files '*.md,**/*.md,docs/**,notes/**,scripts/windows/**,scripts/wsl/**' \
    --include-logs-with-status --description "Test, build and deploy $SERVICE on push to $BRANCH" >/dev/null; then
  echo
  echo "    Could not create the trigger. Connect the repository to Cloud Build first (one time, in the browser):"
  echo "    https://console.cloud.google.com/cloud-build/triggers;region=global/connect?project=$PROJECT_ID"
  echo "    Choose GitHub (Cloud Build GitHub App), select $REPO_OWNER/$REPO_NAME, skip creating a trigger,"
  echo "    then run this script again."
  exit 1
fi

echo
echo "==> Auto-deploy is on: every push to $BRANCH runs tests, builds and deploys $SERVICE."
echo "    Run now:  gcloud builds triggers run $TRIGGER --branch $BRANCH"
echo "    Builds:   https://console.cloud.google.com/cloud-build/builds?project=$PROJECT_ID"
