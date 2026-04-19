# gundo-workflows

Reusable GitHub Actions workflows and templates for the Gundo platform. One place to change the way every Gundo project builds, tests, scans, signs, and deploys.

## What lives here

| Path | Purpose |
|---|---|
| `.github/workflows/reusable-ci.yml` | Lint + typecheck + build + tests + Trivy scan for any pnpm monorepo |
| `.github/workflows/reusable-build-sign.yml` | Build Docker image → push to Artifact Registry → Cosign sign → SPDX SBOM |
| `.github/workflows/reusable-deploy-cloudrun.yml` | Canary deploy to Cloud Run with SLO-watched auto-rollback |
| `.github/workflows/reusable-deploy-firebase.yml` | Firebase Hosting deploy using WIF (no JSON keys) |
| `.github/workflows/reusable-preview.yml` | Per-PR Cloud Run preview revisions (tagged, zero traffic) |
| `.github/workflows/reusable-publish-npm.yml` | semantic-release publish to GitHub Packages |
| `actions/deploy-reporter/` | Composite action that reports deploy lifecycle to Feedback Hub |
| `cloudbuild/cloudbuild.template.yaml` | Cloud Build pipeline (for repos that prefer GCB over Actions) |
| `scripts/canary-watch.sh` | Cloud Monitoring SLO watcher for canary rollouts |
| `scripts/report-deployment.sh` | POSTs lifecycle events to Feedback Hub DevOps endpoint |
| `scripts/cleanup-pr-tags.sh` | Removes `pr-<n>` Cloud Run tags when a PR closes |
| `docs/ONBOARDING.md` | Step-by-step guide for adopting these workflows in a new repo |
| `docs/ADR/` | Architecture Decision Records |

## Quick start

In your repo's `.github/workflows/ci.yml`:

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
    if: github.ref == 'refs/heads/main'
    uses: jplannnou/gundo-workflows/.github/workflows/reusable-build-sign.yml@v1
    with:
      gcp-project: gundo-content-engine
      service: gundo-engine
      dockerfile: backend/Dockerfile
      workload-identity-provider: projects/744494884826/locations/global/workloadIdentityPools/github/providers/github-provider
      service-account: ci-deploy@gundo-content-engine.iam.gserviceaccount.com

  deploy:
    needs: build
    uses: jplannnou/gundo-workflows/.github/workflows/reusable-deploy-cloudrun.yml@v1
    with:
      gcp-project: gundo-content-engine
      service: gundo-engine
      image: ${{ needs.build.outputs.image }}
      workload-identity-provider: projects/744494884826/locations/global/workloadIdentityPools/github/providers/github-provider
      service-account: ci-deploy@gundo-content-engine.iam.gserviceaccount.com
      runtime-service-account: gundo-engine-runtime@gundo-content-engine.iam.gserviceaccount.com
      memory: '4Gi'
      max-p95-latency-ms: 2000
    secrets:
      FEEDBACK_HUB_API_KEY: ${{ secrets.FEEDBACK_HUB_API_KEY }}
```

See [docs/ONBOARDING.md](docs/ONBOARDING.md) for the full setup (WIF provider, IAM bindings, secrets, etc.).

## Versioning

This repo follows semver via git tags:

- `v1.2.3` — exact pin (reproducible)
- `v1` — major tag, moves forward on minor/patch releases (recommended for consumers)
- `main` — do not use from consumers

Consumer repos pin `@v1` and get improvements automatically. Breaking changes cut a new major.

## Design principles

1. **DRY radical** — any change to how we build, deploy, or observe happens in one repo.
2. **Zero long-lived secrets** — everything is WIF/OIDC or short-lived token.
3. **Fail-safe by default** — canary watch blocks promotion if SLO breaks.
4. **Observable** — every deploy writes to the DevOps dashboard in Command Center.
5. **Progressive enhancement** — new capabilities are opt-in flags, existing callers stay green.

See [docs/ADR/001-reusable-workflows.md](docs/ADR/001-reusable-workflows.md) for the rationale.

## Status

- [x] Fase 0 · Estructura base + reusable workflows (in review)
- [ ] Fase 1 · Piloto en Gundo Engine
- [ ] Fase 2 · Rollout a Finance, Radar, JP Assistant, Feedback Hub BE
- [ ] Fase 3 · Frontends con WIF + preview deploys
- [ ] Fase 4 · Libs con semantic-release
- [ ] Fase 5 · Supply chain hardening (Binary Authorization)
- [ ] Fase 6 · DevOps dashboard en Command Center
