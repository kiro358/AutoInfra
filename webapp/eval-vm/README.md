# Eval VM (throwaway, Vertex)

Runs the golden eval on stable GCP infra (no laptop sleep-kills / socket drops) and exports
results + fresh predictions to GCS. See ../../EVAL_METHODOLOGY.md for the workflow.

## Launch
```bash
# 1. stage the current code
git archive --format=tar.gz -o /tmp/repo.tgz HEAD
gsutil cp /tmp/repo.tgz gs://autoinfra-ai-eval-data/eval-run/autoinfra-repo.tar.gz

# 2. create the VM (eval-env via FILE — values contain commas). Example: full set, 3 repeats.
printf 'GOLDEN_REPEATS=3 GOLDEN_CONCURRENCY=4 BATCH_CONCURRENCY=3' > /tmp/evalenv.txt
gcloud compute instances create autoinfra-eval --zone=us-central1-a --machine-type=e2-standard-8 \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=100GB --scopes=cloud-platform \
  --metadata=results-name=golden-results-full.json \
  --metadata-from-file=startup-script=eval-vm/startup.sh,eval-env=/tmp/evalenv.txt
# It self-halts when done. Delete with: gcloud compute instances delete autoinfra-eval --zone=us-central1-a
```

## Analyze fresh predictions offline (free)
```bash
gsutil cp gs://autoinfra-ai-eval-data/eval-run/predictions.tgz /tmp/
mkdir -p /tmp/fresh && tar xzf /tmp/predictions.tgz -C /tmp/fresh --strip-components=1
# analyze:eval reads predictions from PREDICTIONS_DIR + truth from the real training dir
# (non-destructive — doesn't overwrite your local predicted_facts):
PREDICTIONS_DIR=/tmp/fresh npm run analyze:eval
```
