#!/bin/bash
# Startup script for the throwaway eval VM (GCE, Debian). Pulls the repo tarball + golden
# dataset from GCS, runs the golden eval on Vertex (stable network — no UND_ERR_SOCKET),
# exports results AND fresh predicted_facts to GCS for offline analyze:eval, then self-halts.
#
# Config via instance metadata:
#   eval-env      : env assignments for the run (NO commas-in-values with --metadata; pass via
#                   --metadata-from-file). e.g. "GOLDEN_FOCUS=true GOLDEN_REPEATS=3 GOLDEN_CONCURRENCY=4"
#   results-name  : GCS filename for golden-results.json (e.g. golden-results-full.json)
# See EVAL_METHODOLOGY.md for the workflow.
exec > /var/log/autoinfra-eval.log 2>&1
set -x
echo "=== AutoInfra eval VM boot $(date) ==="
export HOME=/root DEBIAN_FRONTEND=noninteractive
EVAL_ENV=$(curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/eval-env" || true)
[ -z "$EVAL_ENV" ] && EVAL_ENV="GOLDEN_REPEATS=3 GOLDEN_CONCURRENCY=4 BATCH_CONCURRENCY=3"
RESULTS_NAME=$(curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/results-name" || echo golden-results.json)
apt-get update -y && apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - ; apt-get install -y nodejs ; node --version
mkdir -p /opt/autoinfra && cd /opt/autoinfra
gsutil cp gs://autoinfra-ai-eval-data/eval-run/autoinfra-repo.tar.gz . ; tar xzf autoinfra-repo.tar.gz
mkdir -p existing_projects_training_data
gsutil cp gs://autoinfra-ai-eval-data/eval-run/golden_folders.txt /tmp/gf.txt
while IFS= read -r f; do [ -z "$f" ] && continue; gsutil -m cp -r "gs://autoinfra-ai-eval-data/${f}" "existing_projects_training_data/" 2>&1 | tail -1; done < /tmp/gf.txt
cd /opt/autoinfra/webapp && npm install --no-audit --no-fund 2>&1 | tail -3
export USE_VERTEX_AI=true GCP_PROJECT_ID=autoinfra-ai GCP_LOCATION=us-central1 ENABLE_EVAL_CACHE=false
# Export results + predictions + a full log AFTER EVERY PASS. Pass 1 already produces
# every scored project's predicted_facts.json; exporting here means a later hang on the
# straggler-retry passes never costs us the fresh predictions or the diagnostic log.
export_artifacts() {
  gsutil cp /opt/autoinfra/golden-results.json "gs://autoinfra-ai-eval-data/eval-run/${RESULTS_NAME}" 2>/dev/null || true
  gsutil cp /var/log/autoinfra-eval.log "gs://autoinfra-ai-eval-data/eval-run/eval.log" 2>/dev/null || true
  # unique per-run log so the failure detail survives (the shared eval.log is overwritten by other runs)
  gsutil cp /var/log/autoinfra-eval.log "gs://autoinfra-ai-eval-data/eval-run/log-${RESULTS_NAME}.txt" 2>/dev/null || true
  ( cd /opt/autoinfra && tar czf /tmp/predictions.tgz existing_projects_training_data/*/generated_spreadsheets/predicted_facts.json 2>/dev/null ) || true
  gsutil cp /tmp/predictions.tgz gs://autoinfra-ai-eval-data/eval-run/predictions.tgz 2>/dev/null || true
}
for pass in 1 2 3; do
  echo "=== EVAL PASS $pass ($EVAL_ENV) $(date) ==="
  # Straggler passes: after pass 1 the bulk is cached; retry the projects that came back
  # empty at LOW concurrency (GOLDEN_CONCURRENCY=1) — the chronic drops are load-induced
  # Vertex failures, so serial retries recover them without the full-16 request pressure.
  PASS_ENV="$EVAL_ENV"
  [ "$pass" != "1" ] && PASS_ENV="$EVAL_ENV GOLDEN_CONCURRENCY=1 BATCH_CONCURRENCY=1"
  env $PASS_ENV GOLDEN_RESUME=true npm run evaluate:golden 2>&1 | tee -a /var/log/autoinfra-eval.log | tail -45
  export_artifacts
done
echo "=== DONE $(date) ==="
shutdown -h now
