#!/bin/bash
# SessionStart hook for AutoInfra — makes web sessions turnkey for tests + eval.
# - installs webapp deps (so `npm test` / tsc work)
# - reports whether the Gemini key and the (gitignored) dataset are present
# - optionally pulls the dataset from GCS if AUTOINFRA_DATASET_GCS_URI is set
# Synchronous + idempotent. Never hard-fails the session except on dep install.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WEBAPP="$ROOT/webapp"
DATA_DIR="$ROOT/existing_projects_training_data"

echo "[session-start] AutoInfra setup…"

# 1) Dependencies (required) — `npm install` caches well in the web container.
if [ -d "$WEBAPP" ]; then
  echo "[session-start] Installing webapp dependencies…"
  ( cd "$WEBAPP" && npm install --no-audit --no-fund ) || {
    echo "[session-start] ‼️ npm install failed"; exit 1;
  }
else
  echo "[session-start] ‼️ webapp/ not found at $WEBAPP"; exit 1
fi

# 2) Gemini credentials (needed only to RUN extraction, not for unit tests).
if [ -n "${GEMINI_API_KEY:-}" ]; then
  echo "[session-start] ✅ GEMINI_API_KEY is set (AI Studio path available)."
elif [ "${USE_VERTEX_AI:-}" = "true" ] && [ -n "${GCP_PROJECT_ID:-}" ]; then
  echo "[session-start] ✅ Vertex AI configured (USE_VERTEX_AI + GCP_PROJECT_ID)."
else
  echo "[session-start] ⚠️  No Gemini credentials. Set GEMINI_API_KEY (or USE_VERTEX_AI=true + GCP_PROJECT_ID) to run the pipeline / golden eval. Unit tests still run without it."
fi

# 3) Ground-truth dataset (gitignored). Pull from GCS if configured and absent.
if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  echo "[session-start] ✅ Dataset present at existing_projects_training_data/."
elif [ -n "${AUTOINFRA_DATASET_GCS_URI:-}" ] && command -v gsutil >/dev/null 2>&1; then
  echo "[session-start] Fetching dataset from $AUTOINFRA_DATASET_GCS_URI …"
  mkdir -p "$DATA_DIR"
  gsutil -m cp -r "$AUTOINFRA_DATASET_GCS_URI/*" "$DATA_DIR/" \
    && echo "[session-start] ✅ Dataset downloaded." \
    || echo "[session-start] ⚠️  Dataset fetch failed (check bucket/auth/network policy)."
else
  echo "[session-start] ⚠️  No dataset. The golden eval needs existing_projects_training_data/. Set AUTOINFRA_DATASET_GCS_URI=gs://<bucket>/<path> (with GCS auth) to auto-pull, or copy it in manually. Unit tests don't need it."
fi

echo "[session-start] Done. Unit tests: (cd webapp && npm test)"
