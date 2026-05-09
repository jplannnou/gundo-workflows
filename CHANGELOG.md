# Changelog

All notable changes to `gundo-workflows` are documented here.

## [Unreleased]

### Fixed
- `reusable-deploy-cloudrun.yml`: remove `canary-<sha>` tag after promote/rollback to prevent revisions from being pinned indefinitely. Pinned tags kept old revisions running 24/7 even when a service template was updated to safe defaults — the bug surfaced as €76/day Cloud Run bleed across Engine + Radar + Finance + Genie in May 2026 (122 stale canary tags accumulated). Promote now uses `--to-revisions=$REV=100 --remove-tags=$TAG` (atomic), rollback uses the same pattern when restoring the stable revision. Behavior is unchanged for consumers; cleanup happens transparently.
- `reusable-deploy-cloudrun.yml`: added an `if: always()` cleanup step that runs `--remove-tags` even when the job is cancelled mid-flight (concurrency `cancel-in-progress`, manual cancel, runner timeout). Without this guard, a cancelled deploy that already created the canary revision would leave the tag pinned forever — same end state as the pre-fix bug. Edge case discovered 2026-05-08 when consecutive merges to `main` cancelled an in-progress Engine deploy and orphaned `canary-1820f93`. Idempotent: `--remove-tags` on a missing tag is a no-op.

### Added
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
