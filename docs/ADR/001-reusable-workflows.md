# ADR 001 · Reusable workflows in a central repo

- **Status**: Accepted
- **Date**: 2026-04-18
- **Author**: JP Lannou
- **Supersedes**: — (first ADR)

## Context

Gundo runs 10+ services across 4 GCP projects, 2 GitHub orgs, and a mix of pnpm monorepos. Every repo has its own `ci.yml` with hand-rolled build + deploy steps. The pipelines have drifted:

- 4 backends use WIF; 5 frontends still use long-lived Firebase JSON keys.
- GitHub Action versions range from `@v4` to `@v6` across repos.
- Secret naming is inconsistent (`FINANCE_*`, `RADAR_*`, no prefix in Engine).
- Only Radar has any kind of post-deploy callback (changelog to Hub). None have Slack/email notifications (and per JP, Slack is not an option).
- Cloud Run deploys go directly to 100% traffic — a bad deploy is an outage until someone notices.
- `Feedback Hub` backend, shared by 4 products, has no CI/CD at all — manual `gcloud builds submit`.

The 4-lens review on adding more hand-rolled pipelines per repo flags it on all four axes:
- **UX for the dev team**: a fix to canary rollout would require PRs in 10 repos.
- **Security**: long-lived keys and unsigned images are below our benchmark.
- **Infra**: drift compounds; Renovate can't harmonize 10 independent pipelines.
- **Business**: downtime from a bad deploy is the single worst operational risk for B2B2C with retail customers expecting 24/7 APIs.

## Decision

Centralize CI/CD into **`gundo-workflows`** — a single repo exposing reusable GitHub Actions workflows, composite actions, and Cloud Build templates. All projects call these workflows with `uses: jplannnou/gundo-workflows/...@v1`.

Core design calls:

1. **Reusable workflows, not templates**. Templates get copy-pasted and drift; reusable workflows stay DRY forever. Callers override via `inputs`, not by editing YAML.
2. **Pin major tags** (`@v1`). Consumers get patch/minor improvements automatically, breaking changes require explicit bump.
3. **WIF only**. No long-lived keys for GCP or Firebase. Short-lived OIDC tokens for every auth.
4. **Canary with SLO watch is the default**. `skip-canary: true` exists as an emergency escape hatch.
5. **Self-observing**. Every lifecycle event (`building`, `canary`, `promoted`, `rolled_back`) is reported to the Feedback Hub's `/api/devops/deployments` endpoint, feeding a dashboard in Command Center. We dogfood our own observability.
6. **Notifications via Resend + Command Center, never Slack.** Gundo has no Slack workspace; per-email alerts for failures and rollbacks.

## Alternatives considered

### A. Template repo (cookiecutter-style)
Each new repo copies a template `ci.yml`. Simple, zero indirection.
- ❌ Drift. Same problem we have today.
- ❌ A canary fix requires 10 PRs.

### B. One monorepo for all services
Single repo, single pipeline.
- ❌ Gundo already has 10 repos with separate histories and permissions (Finance is private, Gundo-Health org is separate team).
- ❌ Migration cost prohibitive.

### C. Backstage / internal developer portal
Full platform engineering tooling.
- ❌ Premature for a ~1-person team.
- ❌ Learning curve + hosting cost.
- ✅ Worth revisiting at 15+ services or first full-time infra hire.

### D. Third-party CI platform (CircleCI, Buildkite)
- ❌ Another bill and another auth boundary.
- ❌ GitHub Actions + Cloud Build already cover 95% of needs.

## Consequences

### Positive

- **Single point of change**: a tweak to the canary watch ships to 10 repos by bumping `@v1` tag.
- **Security posture**: zero long-lived keys, signed images, SBOM, optional Binary Authorization.
- **Observability**: DORA metrics (deploy freq, MTTR, CFR, lead time) become computable from the `deployments` collection.
- **Onboarding new repos**: a `ci.yml` of ~40 lines instead of ~400.

### Negative

- **Coupling to the central repo**: a bug in `reusable-deploy-cloudrun.yml` would block every deploy. Mitigation: pin `@v1.2.3` exact for critical services, graduate to `@v1` after a cooling period.
- **Cross-org visibility**: reusable workflows in a private repo can only be consumed within the same org. This repo lives in `jplannnou` and is either (a) public since it contains no secrets, or (b) duplicated in `Gundo-Health-and-Food`. Decision pending — default to **public** because the workflows themselves are not sensitive (secrets are injected at the caller site).
- **Debugging layer**: when something fails, the stack trace points into a reusable workflow. Mitigation: clear error messages, every step has an `id` and a `name`, script output is captured in job logs.

## Migration sequence

1. Pilot in Gundo Engine (most complex — Puppeteer + FFmpeg).
2. Once piloted, migrate Finance, Radar, JP Assistant, Feedback Hub backend.
3. Move all frontends to WIF (Firebase deploy via `google-github-actions/auth@v3` + impersonation).
4. Add preview deploys per PR (Cloud Run tag `pr-<n>` or Firebase preview channel).
5. Migrate `@gundo/ui` and `@gundo/feedback-sdk` to semantic-release.
6. Cosign + SBOM + Binary Authorization enforcement.
7. DevOps dashboard in Command Center.

## Unresolved questions

- **Org hosting**: jplannnou (public) vs Gundo-Health-and-Food (private, duplicate). Leaning public.
- **Release cadence for `gundo-workflows`**: manual tags for now. Evaluate `semantic-release` after Fase 5.
- **Disaster plan for `gundo-workflows` outage**: every repo keeps its existing `cloudbuild.yaml` as a fallback, callable via `gcloud builds submit` (which needs no GitHub). Document this.
