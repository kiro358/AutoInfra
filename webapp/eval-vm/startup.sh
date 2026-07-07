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
for pass in 1 2 3; do
  echo "=== EVAL PASS $pass ($EVAL_ENV) $(date) ==="
  env $EVAL_ENV GOLDEN_RESUME=true npm run evaluate:golden 2>&1 | tee -a /var/log/autoinfra-eval.log | tail -45
  gsutil cp /opt/autoinfra/golden-results.json "gs://autoinfra-ai-eval-data/eval-run/${RESULTS_NAME}" 2>/dev/null || true
  gsutil cp /var/log/autoinfra-eval.log gs://autoinfra-ai-eval-data/eval-run/eval.log 2>/dev/null || true
done
echo "=== EXPORT fresh predictions for offline analyze:eval $(date) ==="
cd /opt/autoinfra && tar czf /tmp/predictions.tgz existing_projects_training_data/*/generated_spreadsheets/predicted_facts.json 2>/dev/null || true
gsutil cp /tmp/predictions.tgz gs://autoinfra-ai-eval-data/eval-run/predictions.tgz || true
gsutil cp /opt/autoinfra/golden-results.json "gs://autoinfra-ai-eval-data/eval-run/${RESULTS_NAME}" || true
echo "=== DONE $(date) ==="
shutdown -h now
