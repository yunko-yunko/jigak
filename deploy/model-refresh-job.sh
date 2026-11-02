#!/usr/bin/env bash
# One-time setup of the production model refresh: bucket, service accounts, secret, image, Cloud Run Job,
# Cloud Scheduler trigger, alerts. Everything in Seoul (asia-northeast3).
#
#   bash deploy/model-refresh-job.sh --project P              # PLAN: prints the commands, calls nothing
#   bash deploy/model-refresh-job.sh --project P --apply       # runs them (asks nothing more: read the plan first)
# (from the backend repository root; in the monorepo the same file is jigak-backend/deploy/model-refresh-job.sh)
# The job image is built from this repository alone (model-refresh/Dockerfile). Only step 8 (seeding the bucket) needs
# the untracked operating models: run it in the monorepo, or pass --bundle with a folder made there by models:store:bundle.
#
# Without --apply this script never calls gcloud (it works on a machine that has no gcloud). With --apply
# every create step first checks whether the resource exists, so a second run only fills in what is missing.
# Secrets: this script never reads or prints a key. Step 4 prints the one line you run yourself.
set -euo pipefail

PROJECT=""; BUCKET=""; REGION="asia-northeast3"; SERVICE="jigakmap-api"; RUNTIME_SA=""
JOB="jigak-model-refresh"; JOB_SA_NAME="jigak-model-refresh"; SCHED_SA_NAME="jigak-refresh-scheduler"
REPO="jigak"; IMAGE_TAG="$(date +%Y%m%d-%H%M)"; SECRET="data-go-kr-service-key"; SECRET_VERSION="1"
ALERT_EMAIL=""; API_HOST=""; SCHEDULE="30 5,9,13 * * *"; APPLY=0; FROM_STEP=1; BUNDLE_DIR=""
CPU="8"; MEMORY="32Gi"; TASK_TIMEOUT="3h"; MAX_RETRIES="1"

usage() { sed -n '2,13p' "$0"; cat <<'EOF'

Options
  --project P            GCP project id (required)
  --bucket B             models bucket (default P-jigak-models, asia-northeast3)
  --service NAME         existing Cloud Run API service (default jigakmap-api), used only to read its runtime service account
  --runtime-sa EMAIL     the API service's runtime service account (read-only access to the bucket); default: read from the service
  --image-tag TAG        image tag (default: timestamp)
  --secret-version N     version of secret data-go-kr-service-key to pin (default 1)
  --alert-email ADDR     create an email channel and the alert policies (skipped when empty)
  --api-host HOST        API host name for the health uptime check (e.g. api.example.com); skipped when empty
  --bundle DIR           step 8: an existing bootstrap folder (npm run models:store:bundle -- --out DIR, made in the monorepo)
  --from-step N          start at step N (resume after a failure)
  --apply                actually run the commands
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --runtime-sa) RUNTIME_SA="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --secret-version) SECRET_VERSION="$2"; shift 2 ;;
    --alert-email) ALERT_EMAIL="$2"; shift 2 ;;
    --api-host) API_HOST="$2"; shift 2 ;;
    --bundle) BUNDLE_DIR="$2"; shift 2 ;;
    --from-step) FROM_STEP="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] || { echo "--project is required" >&2; usage >&2; exit 2; }
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo "invalid project id: $PROJECT" >&2; exit 2; }
[ -n "$BUCKET" ] || BUCKET="${PROJECT}-jigak-models"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || { echo "invalid bucket name: $BUCKET" >&2; exit 2; }
[[ "$SECRET_VERSION" =~ ^[1-9][0-9]*$ ]] || { echo "--secret-version must be a number" >&2; exit 2; }

# The backend repository root (jigak-backend/ in the monorepo): model-refresh/ and deploy/ live here.
BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOB_SA="${JOB_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SCHED_SA="${SCHED_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/jigak-model-refresh:${IMAGE_TAG}"
GC=(gcloud --project "$PROJECT" --quiet)

if [ "$APPLY" = 1 ]; then
  command -v gcloud >/dev/null || { echo "install and authenticate the Google Cloud CLI first" >&2; exit 1; }
  echo "# APPLY mode: project=$PROJECT region=$REGION bucket=gs://$BUCKET"
else
  echo "# PLAN only (add --apply to run). project=$PROJECT region=$REGION bucket=gs://$BUCKET image=$IMAGE"
fi

STEP=0
step() { STEP=$((STEP + 1)); echo; echo "## step $STEP: $1"; }
skip() { [ "$STEP" -lt "$FROM_STEP" ]; }
show() { printf '+'; printf ' %q' "$@"; printf '\n'; }
# run CMD...: print, and execute only with --apply.
run() { skip && return 0; show "$@"; if [ "$APPLY" = 1 ]; then "$@"; fi; return 0; }
# ensure "<describe command string>" CMD...: create only when describe fails (apply mode).
ensure() {
  local describe="$1"; shift
  skip && return 0
  if [ "$APPLY" = 1 ]; then
    if eval "$describe" >/dev/null 2>&1; then echo "# exists, skipped: $*" | cut -c1-110; return 0; fi
  else
    echo "# (created only if missing)"
  fi
  show "$@"; if [ "$APPLY" = 1 ]; then "$@"; fi; return 0
}

step "enable APIs"
run "${GC[@]}" services enable run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com monitoring.googleapis.com logging.googleapis.com storage.googleapis.com

step "Artifact Registry repository (docker, Seoul)"
ensure "${GC[*]} artifacts repositories describe $REPO --location $REGION" \
  "${GC[@]}" artifacts repositories create "$REPO" --repository-format docker --location "$REGION" \
  --description "jigak images"

step "models bucket in Seoul: uniform access, versioning, lifecycle (old versions 14 days, raw/ 21 days)"
# Explicit XXXXXX template: GNU mktemp (Linux, Cloud Shell, WSL) rejects `-t name` without X's; macOS accepts both.
LIFECYCLE="$(mktemp "${TMPDIR:-/tmp}/jigak-lifecycle.XXXXXX")"
trap 'rm -f "$LIFECYCLE"' EXIT
cat > "$LIFECYCLE" <<'JSON'
{"rule":[
 {"action":{"type":"Delete"},"condition":{"daysSinceNoncurrentTime":14,"isLive":false}},
 {"action":{"type":"Delete"},"condition":{"age":21,"matchesPrefix":["raw/"]}}
]}
JSON
ensure "${GC[*]} storage buckets describe gs://$BUCKET" \
  "${GC[@]}" storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access \
  --public-access-prevention
run "${GC[@]}" storage buckets update "gs://$BUCKET" --versioning
run "${GC[@]}" storage buckets update "gs://$BUCKET" --lifecycle-file "$LIFECYCLE"

step "service accounts and least-privilege IAM"
ensure "${GC[*]} iam service-accounts describe $JOB_SA" \
  "${GC[@]}" iam service-accounts create "$JOB_SA_NAME" --display-name "jigak model refresh job"
ensure "${GC[*]} iam service-accounts describe $SCHED_SA" \
  "${GC[@]}" iam service-accounts create "$SCHED_SA_NAME" --display-name "jigak refresh scheduler"
# Read, write and delete objects in this one bucket (retention cleanup deletes). Not objectAdmin: no ACL/IAM rights.
run "${GC[@]}" storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$JOB_SA" --role roles/storage.objectUser
# The API service only reads.
if [ -z "$RUNTIME_SA" ]; then
  if [ "$APPLY" = 1 ] && ! skip; then
    RUNTIME_SA="$("${GC[@]}" run services describe "$SERVICE" --region "$REGION" --format 'value(spec.template.spec.serviceAccountName)')"
  else
    RUNTIME_SA="<runtime service account of $SERVICE>"
  fi
fi
run "${GC[@]}" storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$RUNTIME_SA" --role roles/storage.objectViewer

step "secret for the data.go.kr key (only the job service account may read it)"
ensure "${GC[*]} secrets describe $SECRET" \
  "${GC[@]}" secrets create "$SECRET" --replication-policy user-managed --locations "$REGION"
run "${GC[@]}" secrets add-iam-policy-binding "$SECRET" --member "serviceAccount:$JOB_SA" --role roles/secretmanager.secretAccessor
echo "# YOU run this once, with your key (it is not read or printed here):"
echo "#   read -rs KEY && printf %s \"\$KEY\" | gcloud --project $PROJECT secrets versions add $SECRET --data-file=- ; unset KEY"
if [ "$APPLY" = 1 ] && ! skip; then
  "${GC[@]}" secrets versions describe "$SECRET_VERSION" --secret "$SECRET" >/dev/null 2>&1 \
    || { echo "secret $SECRET has no version $SECRET_VERSION yet: add it (line above), then rerun with --from-step $((STEP + 1))" >&2; exit 1; }
fi

step "build and push the image (backend repository as the context, Cloud Build in Seoul)"
# .gcloudignore keeps node_modules, dist, .env and local data out of the upload; model-refresh/Dockerfile.dockerignore
# keeps the build context to the job's files. Later images come from the push trigger (model-refresh/cloudbuild.trigger.yaml).
run "${GC[@]}" builds submit "$BACKEND" --region "$REGION" --config "$BACKEND/model-refresh/cloudbuild.yaml" \
  --substitutions "_IMAGE=$IMAGE"

step "Cloud Run Job (Seoul): ${CPU} vCPU / ${MEMORY}, task timeout ${TASK_TIMEOUT}, 1 retry, 1 task"
# Cost guard: 1 task, no parallelism, at most 3 scheduler starts a day, a run that has nothing to do ends within a minute.
# implicit-dirs is Cloud Run's default; written out so the setting is visible.
run "${GC[@]}" run jobs deploy "$JOB" --region "$REGION" --image "$IMAGE" \
  --cpu "$CPU" --memory "$MEMORY" --task-timeout "$TASK_TIMEOUT" --max-retries "$MAX_RETRIES" --tasks 1 --parallelism 1 \
  --service-account "$JOB_SA" \
  --set-secrets "DATA_GO_KR_SERVICE_KEY=${SECRET}:${SECRET_VERSION}" \
  --set-env-vars "MODEL_REFRESH_MODE=cloud,TZ=Asia/Seoul" \
  --add-volume "name=models,type=cloud-storage,bucket=${BUCKET},mount-options=implicit-dirs" \
  --add-volume-mount "volume=models,mount-path=/models-store"

step "seed the bucket: first manifest generation from the current operating models (bundle uploaded, then initialised by one Job run)"
# The bundle (operating models, journals, calendars, the 따릉이 seed, fixed inputs, incumbent references) is made from the
# monorepo's untracked files: models:store:bundle finds cloud-models/ and mvp/data/ two levels above model-refresh/.
BUNDLE="${BUNDLE_DIR:-${TMPDIR:-/tmp}/jigak-store-bootstrap}"
echo "# refuses to overwrite: when gs://$BUCKET/manifest.json already exists only the incumbent references are added (no-clobber)"
# Returns 1 (does not exit) when there is nothing to make the bundle from: the caller decides whether that is fatal.
make_bundle() {
  if [ -n "$BUNDLE_DIR" ]; then
    [ -d "$BUNDLE_DIR/operational" ] || { echo "--bundle $BUNDLE_DIR has no operational/ folder" >&2; return 1; }
  else
    [ -d "$BACKEND/../mvp" ] || { echo "no monorepo next to $BACKEND: make the bundle there (npm --prefix jigak-backend run models:store:bundle -- --out DIR) and pass --bundle DIR" >&2; return 1; }
    rm -rf "$BUNDLE"; npm --prefix "$BACKEND" run models:store:bundle -- --out "$BUNDLE" || return 1
  fi
}
if ! skip; then
  [ -n "$BUNDLE_DIR" ] || show npm --prefix "$BACKEND" run models:store:bundle -- --out "$BUNDLE"
  show "${GC[@]}" storage rsync --recursive "$BUNDLE" "gs://$BUCKET/bootstrap"
  show "${GC[@]}" run jobs execute "$JOB" --region "$REGION" --args=init,--from-bundle,/models-store/bootstrap --wait
  echo "# (bucket already seeded instead:)"
  show "${GC[@]}" storage cp --recursive --no-clobber "$BUNDLE/references" "gs://$BUCKET/"
  if [ "$APPLY" = 1 ]; then
    if "${GC[@]}" storage ls "gs://$BUCKET/manifest.json" >/dev/null 2>&1; then
      echo "manifest.json already exists in the bucket: not seeding again; adding the incumbent references it lacks" >&2
      # A second run from a backend-only clone has no bundle source: warn and go on with the later steps.
      if make_bundle; then
        if [ -d "$BUNDLE/references" ]; then "${GC[@]}" storage cp --recursive --no-clobber "$BUNDLE/references" "gs://$BUCKET/"; fi
      else
        echo "WARNING: skipped adding incumbent references (no --bundle and no monorepo); the seeded bucket is left as it is" >&2
      fi
    else
      make_bundle || exit 1
      "${GC[@]}" storage rsync --recursive "$BUNDLE" "gs://$BUCKET/bootstrap"
      "${GC[@]}" run jobs execute "$JOB" --region "$REGION" --args=init,--from-bundle,/models-store/bootstrap --wait
    fi
    [ -n "$BUNDLE_DIR" ] || rm -rf "$BUNDLE"
  fi
fi

step "Cloud Scheduler trigger: ${SCHEDULE} Asia/Seoul"
run "${GC[@]}" run jobs add-iam-policy-binding "$JOB" --region "$REGION" --member "serviceAccount:$SCHED_SA" --role roles/run.invoker
SCHED_ARGS=(scheduler jobs create http "$JOB" --location "$REGION" --schedule "$SCHEDULE" --time-zone Asia/Seoul
  --uri "https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
  --http-method POST --oauth-service-account-email "$SCHED_SA" --attempt-deadline 180s)
ensure "${GC[*]} scheduler jobs describe $JOB --location $REGION" "${GC[@]}" "${SCHED_ARGS[@]}"

step "first run (plan only: lists what the job would do, changes nothing)"
run "${GC[@]}" run jobs execute "$JOB" --region "$REGION" --args=--plan --wait

step "API service: mount the bucket read-only and follow the manifest (no restart needed afterwards)"
echo "# cloud-run.env.yaml needs MODEL_MANIFEST_PATH: '/models/manifest.json'; leave the ETA_*_PATH values empty (they stay as fallback)."
echo "# Run from PowerShell, with your usual arguments of cloud-run.ps1 plus -ModelBucket:"
echo "#   pwsh $BACKEND/deploy/cloud-run.ps1 -ProjectId $PROJECT ... -ModelBucket $BUCKET"

step "alerts: failed or at-risk refresh, and an uptime check on /api/health"
if [ -n "$ALERT_EMAIL" ]; then
  MON="$BACKEND/model-refresh/monitoring"
  CHANNEL_FILE="${TMPDIR:-/tmp}/jigak-channel.txt"
  # The notification channel and policies need the alpha/beta monitoring commands; check `gcloud components list` first.
  if ! skip; then
    show gcloud --project "$PROJECT" beta monitoring channels create --display-name "jigak model alerts" --type email --channel-labels "email_address=$ALERT_EMAIL" --format "value(name)"
    show gcloud --project "$PROJECT" alpha monitoring policies create --policy-from-file "<$MON/alert-policy-refresh-alert.json with __CHANNEL__ = the channel name>"
    show gcloud --project "$PROJECT" alpha monitoring policies create --policy-from-file "<$MON/alert-policy-job-failed.json with __CHANNEL__ = the channel name>"
    if [ "$APPLY" = 1 ]; then
      CHANNEL="$("${GC[@]}" beta monitoring channels create --display-name "jigak model alerts" --type email \
        --channel-labels "email_address=$ALERT_EMAIL" --format 'value(name)')"
      for policy in alert-policy-refresh-alert alert-policy-job-failed; do
        sed "s|__CHANNEL__|$CHANNEL|" "$MON/$policy.json" > "${TMPDIR:-/tmp}/$policy.json"
        "${GC[@]}" alpha monitoring policies create --policy-from-file "${TMPDIR:-/tmp}/$policy.json"
      done
    fi
  fi
else
  echo "# --alert-email not given: alert policies skipped. Policy files: model-refresh/monitoring/"
fi
if [ -n "$API_HOST" ]; then
  echo "# uptime check (needs the API reachable without sign-in at /api/health; the API deploys with --no-allow-unauthenticated by default)"
  if ! skip; then
    if [ "$APPLY" = 1 ]; then
      sed "s|__PROJECT__|$PROJECT|;s|__API_HOST__|$API_HOST|" "$BACKEND/model-refresh/monitoring/uptime-check-model-health.json" > "${TMPDIR:-/tmp}/jigak-uptime.json"
    fi
    echo "# no verified gcloud command for uptime checks: create it in the console (Monitoring > Uptime checks) with the values in ${TMPDIR:-/tmp}/jigak-uptime.json"
  fi
else
  echo "# --api-host not given: uptime check skipped (file: model-refresh/monitoring/uptime-check-model-health.json)"
fi

echo
echo "# done. Next: docs 'Before the first run' in docs/MODEL-REFRESH.md (verify list), and the push trigger there."
