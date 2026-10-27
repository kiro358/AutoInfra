# Persistent job storage — bucket retention (D2)

Job records and results are written through to GCS by
`webapp/src/lib/job-persistence.ts` (design brief:
`~/workspace/autoinfra-analysis/persistent_storage_brief.md`, Option B).
Objects live under the `jobs/` prefix of the bucket named by `JOBS_BUCKET`
(falling back to `GCS_BUCKET`, then `autoinfra-ai-eval-data`):

- `jobs/<id>/record.json` — job fields + status
- `jobs/<id>/result.json` — result JSON (base64 document fields removed)
- `jobs/<id>/workbook.xlsx`, `jobs/<id>/quote.docx` — result blobs

**Retention is 7 days, enforced by a bucket lifecycle rule — not by app
code.** Apply it once per bucket:

```bash
cat > /tmp/jobs-lifecycle.json <<'JSON'
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": { "age": 7, "matchesPrefix": ["jobs/"] }
      }
    ]
  }
}
JSON
gsutil lifecycle set /tmp/jobs-lifecycle.json gs://autoinfra-ai-eval-data
```

(Substitute the real bucket if `JOBS_BUCKET`/`GCS_BUCKET` point elsewhere.
Verify with `gsutil lifecycle get gs://<bucket>`.)

Notes:

- The rule is prefix-scoped: the eval tile files the bucket also holds are
  untouched.
- Deleting expired objects is what makes a >7-day-old job id return the
  route's honest 404 again — existence inside the window is the guarantee.
- Kill switch: `DISABLE_JOB_PERSISTENCE=1` returns the app to the pure
  in-memory store; already-stored objects are inert and age out under the
  same rule.

<!-- live-proof redeploy trigger 1 — PR 60 proof, 2026-10-27 (no content change) -->

<!-- live-proof redeploy trigger 2 — PR 60 proof, 2026-10-27 (no content change) -->
