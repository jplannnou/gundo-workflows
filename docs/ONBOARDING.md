# Onboarding a repo to gundo-workflows

Step-by-step to migrate an existing Gundo project from its bespoke `ci.yml` to the reusable workflows in this repo.

## Prerequisites checklist

- [ ] Repo belongs to `jplannnou` or `Gundo-Health-and-Food` GitHub org
- [ ] GCP project exists and billing is active
- [ ] Artifact Registry repo `gundo` exists in the target region
- [ ] Cloud Run service already deployed at least once (for rollback reference)
- [ ] You know the runtime SA email for the service

---

## 1. Set up Workload Identity Federation (one-time per GCP project)

Skip if WIF is already configured — Engine, Finance, Radar and JP Assistant already have it.

```bash
PROJECT=gundo-content-engine
PROJECT_NUMBER=744494884826
REPO=jplannnou/gundo-engine   # adjust per repo

# 1. Create the pool (skip if exists)
gcloud iam workload-identity-pools create "github" \
  --project=$PROJECT --location=global \
  --display-name="GitHub Actions Pool"

# 2. Create the provider bound to this repo
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project=$PROJECT --location=global \
  --workload-identity-pool="github" \
  --display-name="GitHub Actions provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="attribute.repository=='$REPO'"

# 3. Create a deploy SA (separate from runtime SA)
gcloud iam service-accounts create ci-deploy \
  --project=$PROJECT \
  --display-name="CI deploy (GitHub Actions)"

DEPLOY_SA="ci-deploy@$PROJECT.iam.gserviceaccount.com"

# 4. Give deploy SA the minimum required roles
for role in \
  roles/artifactregistry.writer \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/monitoring.viewer; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:$DEPLOY_SA" --role="$role"
done

# 5. Bind the provider to the SA
gcloud iam service-accounts add-iam-policy-binding $DEPLOY_SA \
  --project=$PROJECT \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
```

The full provider resource name (for workflow inputs) is:

```
projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/github-provider
```

---

## 2. Configure GitHub secrets

At the repo level (`Settings → Secrets and variables → Actions`):

| Secret | Value | Required for |
|---|---|---|
| `FEEDBACK_HUB_API_KEY` | API key scoped to `devops` | Cloud Run deploys |
| `NODE_AUTH_TOKEN` | Token with `read:packages` | Installing `@jplannnou/*` packages |
| `GH_PACKAGES_TOKEN` | Token with `write:packages` | Only for `@gundo/ui` / `@gundo/feedback-sdk` publish |

WIF replaces the old `FIREBASE_SERVICE_ACCOUNT` JSON key and GCP SA keys. Once WIF is wired, **delete the JSON-key secrets** from the repo.

---

## 3. Replace your existing `ci.yml`

Before (example Engine — ~400 lines):

```yaml
# long hand-rolled pipeline with docker build, gcloud auth, run deploy, etc.
```

After (~40 lines):

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  ci:
    uses: jplannnou/gundo-workflows/.github/workflows/reusable-ci.yml@v1
    with:
      workspaces: 'backend,frontend'
    secrets:
      NODE_AUTH_TOKEN: ${{ secrets.NODE_AUTH_TOKEN }}

  build:
    needs: ci
    if: github.ref == 'refs/heads/main' || github.event_name == 'pull_request'
    uses: jplannnou/gundo-workflows/.github/workflows/reusable-build-sign.yml@v1
    with:
      gcp-project: gundo-content-engine
      service: gundo-engine
      dockerfile: backend/Dockerfile
      workload-identity-provider: projects/744494884826/locations/global/workloadIdentityPools/github/providers/github-provider
      service-account: ci-deploy@gundo-content-engine.iam.gserviceaccount.com

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    uses: jplannnou/gundo-workflows/.github/workflows/reusable-deploy-cloudrun.yml@v1
    with:
      gcp-project: gundo-content-engine
      service: gundo-engine
      image: ${{ needs.build.outputs.image }}
      workload-identity-provider: projects/744494884826/locations/global/workloadIdentityPools/github/providers/github-provider
      service-account: ci-deploy@gundo-content-engine.iam.gserviceaccount.com
      runtime-service-account: gundo-engine-runtime@gundo-content-engine.iam.gserviceaccount.com
      memory: '4Gi'
      cpu: '2'
      max-instances: 10
      min-instances: 1
      max-p95-latency-ms: 2000
    secrets:
      FEEDBACK_HUB_API_KEY: ${{ secrets.FEEDBACK_HUB_API_KEY }}

  preview:
    needs: build
    if: github.event_name == 'pull_request'
    uses: jplannnou/gundo-workflows/.github/workflows/reusable-preview.yml@v1
    with:
      gcp-project: gundo-content-engine
      service: gundo-engine
      image: ${{ needs.build.outputs.image }}
      workload-identity-provider: projects/744494884826/locations/global/workloadIdentityPools/github/providers/github-provider
      service-account: ci-deploy@gundo-content-engine.iam.gserviceaccount.com
      runtime-service-account: gundo-engine-runtime@gundo-content-engine.iam.gserviceaccount.com
```

---

## 4. First-run checklist

- [ ] Open a throwaway PR with a no-op change (e.g. `README.md` bump)
- [ ] Watch the CI job (should pass)
- [ ] Watch the `build` job (first run takes longer — caches the `latest` layer)
- [ ] Watch the `preview` job — confirm the PR gets a preview URL comment
- [ ] Merge to main
- [ ] Watch the `deploy` job:
  - [ ] New revision deployed with `--no-traffic`
  - [ ] Traffic shifts to 10% canary
  - [ ] Canary watch runs for 5 min
  - [ ] Traffic promotes to 100%
- [ ] Check Command Center `/devops` dashboard — deployment should appear
- [ ] Verify Cloud Run console shows the new revision as stable

## 5. Rollback drill (recommended)

Before trusting the pipeline, intentionally break a deploy to see rollback work:

1. Add a broken health check endpoint that returns `500`
2. Merge to main
3. Watch canary traffic shift to 10%
4. See SLO watcher detect the error rate breach (takes 1-2 min)
5. Confirm rollback to previous stable revision
6. See the deploy report status `rolled_back` in Command Center
7. Check you received an email alert

Revert the broken commit and verify the next deploy succeeds.

---

## Troubleshooting

**`Failed to generate Google Cloud Federated Token`** — WIF binding missing. Re-check step 1.5 (the `principalSet://` binding).

**`permission denied: iam.serviceAccounts.actAs`** — The deploy SA needs `roles/iam.serviceAccountUser` on the runtime SA. Add it:
```bash
gcloud iam service-accounts add-iam-policy-binding RUNTIME_SA \
  --member="serviceAccount:DEPLOY_SA" --role="roles/iam.serviceAccountUser"
```

**Canary watch always passes even with errors** — Make sure your service emits requests under the canary tag. Cloud Monitoring takes ~60s to surface new data; the watcher handles that with `--min-requests` but check that traffic is actually hitting the canary tag.

**`cosign verify` fails** — The image wasn't signed, or your repository owner regexp is wrong. Rebuild; the `reusable-build-sign.yml` workflow always signs.

**Deploy report fails but deploy succeeds** — Expected. We never block a deploy because telemetry failed. Check `FEEDBACK_HUB_URL` reachability and API key scope.
