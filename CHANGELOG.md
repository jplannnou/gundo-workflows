# Changelog

All notable changes to `gundo-workflows` are documented here.

## [Unreleased]

### Added
- `reusable-deploy-cloudrun.yml`: new input `public-access` (bool, default `false`). When `true`, grants `allUsers/run.invoker` at the **service level** before the canary deploy. Idempotent. Prevents the silent prod outage that occurs when a tag-pinned `allUsers` binding is removed via `--remove-tags`. See incident memory `incident-cloud-run-remove-tags-strips-iam-2026-05-08.md` (gundo-ecommerce-ui PR #377 admin merge took prod down ~5min). Public B2C services (gundo-ecommerce-ui, ultrapersonalizacion.gundo.life, etc.) should set `public-access: true`. Internal/private services keep the default `false`.
- Initial repo structure (Fase 0 of the Deploy Unificado Gundo plan).
- `reusable-ci.yml` — lint + typecheck + build + test + Trivy scan matrix over pnpm workspaces.
- `reusable-build-sign.yml` — Docker build + push to Artifact Registry + Cosign keyless sign + SPDX SBOM via syft + image scan.
- `reusable-deploy-cloudrun.yml` — canary deploy with SLO-watched auto-rollback, reports lifecycle to Feedback Hub.
- `reusable-deploy-firebase.yml` — Firebase Hosting deploy using Workload Identity Federation.
- `reusable-preview.yml` — per-PR Cloud Run preview revisions (tagged, zero traffic).
- `reusable-publish-npm.yml` — semantic-release publish to GitHub Packages.
- `actions/deploy-reporter/` — composite action to report deploy lifecycle events.
- `cloudbuild/cloudbuild.template.yaml` — templated Cloud Build pipeline for non-GHA repos.
- `scripts/canary-watch.sh` — Cloud Monitoring SLO watcher with consecutive-breach logic.
- `scripts/report-deployment.sh` — POST lifecycle events to Feedback Hub DevOps endpoint.
- `scripts/cleanup-pr-tags.sh` — removes `pr-<n>` tags when PRs close.
- `docs/README.md`, `docs/ONBOARDING.md`, `docs/ADR/001-reusable-workflows.md`, `docs/examples/engine-ci.yml`.

### Pending before tagging `v1`
- First pilot run on Gundo Engine (validate SLO watcher with real Cloud Monitoring data).
- Intentional rollback drill (verify auto-rollback path end-to-end).
- Feedback Hub `/api/devops/deployments` endpoint live in production.
