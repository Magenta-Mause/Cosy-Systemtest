# Cosy Systemtest — agent guide

Playwright end-to-end tests that install Cosy from scratch and drive every feature
through the real UI. This repo is community-owned — all code and comments in
**English**. Read [docs/test-architecture.md](docs/test-architecture.md) before
changing structure.

## Commands

```bash
npm install          # Node >= 22
npm test             # whole suite (chromium)
npm run test:core    # @core specs (grep tag)
npm run typecheck    # tsc --noEmit
npm run systemtest   # runner → results/summary.json + push (exits 0 even on red tests)
npm run systemtest:nopush  # same, but write only — no OTLP push (what CI's suite step runs)
npm run systemtest:push    # push an existing results/summary.json; runs no tests
npm run report       # open last HTML report
npx playwright test --list   # lists all specs even with no install present
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `COSY_BASE_URL` | Target Cosy URL (read only in `helpers/constants.ts`) | `http://localhost:8080` |
| `INSTALL_LOG` | Tee'd installer stdout — admin creds source; **gates every spec** | — (specs skip if unset) |
| `INSTALL_DIR` | Install dir; `.env` fallback read from `${INSTALL_DIR}/config/.env` | `/opt/cosy` |
| `INSTALL_ENV_FILE` | Runner-readable copy of the installed `.env` (preferred over `INSTALL_DIR`; CI copies it because the installed file is root-owned chmod 600) | — (falls back to `INSTALL_DIR`) |
| `SYSTEMTEST_HEAVY` | Enables quarantined heavy specs (`rcon` — needs a full Minecraft boot, never succeeds on a GitHub runner; see docs/KNOWN-ISSUES.md) | — (heavy specs skip) |
| `COSY_CHANNEL` | Channel label in `results/summary.json`; the workflow sets `staging` when a manual run pinned an image tag, else `release` | `release` |
| `COSY_BACKEND_TAG` | Installed backend image tag, written to `summary.json` → `versions.backend` (workflow reads it back out of the installed `.env`) | — (`null` in the summary) |
| `COSY_FRONTEND_TAG` | Installed frontend image tag → `versions.frontend` | — (`null` in the summary) |
| `OTEL_INGEST_URL` | Base URL of the authenticated OTLP-HTTP ingest (SigNoz collector); the runner POSTs to `${OTEL_INGEST_URL}/v1/metrics`. CI sets `https://otel-ingest.jannekeipert.de` (overridable via the `OTEL_INGEST_URL` repo variable) | — (push skipped) |
| `OTEL_INGEST_USER` | HTTP Basic user for the ingest (GitHub secret) | — (push skipped) |
| `OTEL_INGEST_PASSWORD` | HTTP Basic password for the ingest (GitHub secret) | — (push skipped) |
| `CI` | CI reporters + retries | — |

**The push is all-or-nothing on config:** unless all three `OTEL_INGEST_*` are set and
non-empty, the runner logs one INFO line and exits 0 — local runs and forks are
unaffected. When they *are* set, a failed push exits **1** (see convention 8).

## Hard conventions (do not break)

1. **Import `test` / `expect` only from `@fixtures/index`**, never from
   `@playwright/test`.
2. **No selectors in specs.** All selectors + UI actions live in `tests/pages/*`.
   Specs describe behaviour with `test.step('Given/When/Then …')`.
3. **`data-testid`s are owned by the Cosy frontend.** The frontend currently has
   none, so page objects use accessible role/label selectors marked `// TODO(testid)`
   and every gap is logged in [docs/testid-gaps.md](docs/testid-gaps.md). When you
   add an id in `Cosy-Frontend`, switch the page object to `getByTestId` and remove
   the gap row — do **not** invent ids only here.
4. **No raw API calls for assertions in specs.** `helpers/api.ts` (the `apiClient`
   fixture) is for setup/teardown only (login, create/delete/poll servers); features
   are proven through the UI.
5. **Timeouts are named constants** in `helpers/constants.ts` — never inline magic
   numbers. They are deliberately generous (fresh-runner install + cold image pull).
6. **Suite selection is by Playwright tags**, not npm-script file lists. Tag every
   new spec `@core` (install → lifecycle → uninstall) or `@extended` (rest of the
   matrix), and add its feature key to the README matrix. The runner records one
   result row per spec **file** regardless of tag, so keep one feature per file,
   named exactly like the feature key.
7. **Skip guard:** install-gated specs call `runsOnlyWithInstall()` in the describe
   body so they stay listable without an install and skip with one uniform reason.
8. **Runner semantics:** `scripts/run-systemtest.ts` exits 0 even when features fail
   (metrics are truth); it fails only on infrastructure errors — no parseable report,
   a `--push-only` run with no usable `results/summary.json`, or a **failed OTLP
   push**. A push that breaks quietly would leave the dashboard stale with nobody
   noticing, so it is loud and red. `results/summary.json` is always written *before*
   any push, so a failed push never costs us the results.
   **Writing and pushing are separate modes:** `--no-push` (run + write only) and
   `--push-only` (push an existing summary, no Playwright); no flag = both, the local
   default. CI runs them as two steps — see convention 10.
9. **Never report a skip as a pass.** A skipped feature is omitted from
   `cosy_platform_systemtest_feature_status` and
   `cosy_platform_systemtest_feature_duration_seconds` (a `0` duration would read as
   "it got faster") and flagged by `cosy_platform_systemtest_feature_skipped=1`;
   every feature reports that gauge (`0` when it ran) so "this feature stopped
   running" stays visible instead of becoming a gap.
   `cosy_platform_systemtest_run_success` only means "nothing failed" — never read it
   without the skipped gauge. If you add a metric, keep this rule: absence of evidence
   is never reported as evidence of health.
10. **Install/uninstall belong to the workflow**, not to Playwright. `uninstall` is a
    workflow-appended row in `results/summary.json`, not a spec. **The push therefore
    comes last:** the suite step runs `--no-push`, the teardown assertion appends the
    `uninstall` row, and a separate `if: always()` step then runs `--push-only`, so
    SigNoz and the artifact show the same matrix. Never move the push back into the
    suite step — that reported 19 of 20 features and made the dashboard lie. The
    accepted cost: a job cancelled by `timeout-minutes` reports nothing at all (it
    loses the artifact too), which is visible as staleness in
    `cosy_platform_systemtest_last_run_timestamp_seconds`.
11. **A result must be attributable to a build.** The workflow's `backend_tag` /
    `frontend_tag` / `config_ref` dispatch inputs are forwarded to `install_cosy.sh`
    only when non-empty; the effective tags are then read back from the installed
    `.env` into `summary.json` (`versions`), and any override flips `channel` to
    `staging`. The same values ride along as OTLP resource attributes
    (`cosy.backend.image_tag`, `cosy.frontend.image_tag`, `cosy.systemtest.run_url`),
    so a data point in SigNoz names its build and its run. Never drop those fields —
    a red row is meaningless without them.
12. **Every metric name starts with `cosy_platform_systemtest_`.** The shorter
    `cosy_systemtest_*` namespace is already taken in the same SigNoz instance by the
    **Cosy Domain Provider** systemtest (a different product; it reaches SigNoz via
    Pushgateway → Prometheus remote_write and already has a dashboard and alert rules
    on those names). Sharing a metric name across two products silently merges their
    series, so a panel would mix both and an alert would fire for the wrong one.
    `cosy_platform_` names *this* repo's subject: the Cosy game-server platform. Do
    not "simplify" the prefix away, and give any new metric the same one.
13. **`docs/signoz-dashboard.json` is the source of truth for the dashboard**, not
    SigNoz's database. After any edit in the SigNoz UI, export the JSON back over that
    file in the same change — an unexported UI edit is a silent fork. Every panel query
    must wrap its metric in `last_over_time(...[26h])`: a nightly publishes one sample
    per day and Prometheus' 5-minute lookback would otherwise blank the dashboard
    minutes after a run. Alert rules live in the cluster deployment repo under
    `infrastructure/signoz-alerts/`. See the README's "The SigNoz dashboard" section.
14. **Known reds are excluded from paging, never from the suite.** `templates` and
    `server-from-template` (released product bug) and `rcon` (quarantined) are excluded
    from the alert rules and from the dashboard's "Unexpected failures" tile — a rule
    that fires every night forever gets muted and then misses the real regression. They
    are NOT skipped in the suite and NOT hidden on the dashboard, which shows their
    expected counts explicitly. When you add or remove such an exclusion, change the
    rule, the panel and `docs/KNOWN-ISSUES.md` in one commit.

## Layout

```
tests/specs/      one spec file per feature (install, auth, invites, rcon, …)
tests/pages/      page objects (login, home, create-server, server-detail, console,
                  files, users, settings-pages, metrics, public-dashboard-view)
tests/fixtures/   custom test/expect, runsOnlyWithInstall, adminCreds/apiClient/
                  sharedServer/minecraftServer/loggedInPage/secondUserContext/webhookSink
tests/helpers/    install.ts (cred parsing), api.ts (typed client), constants.ts
                  (urls + timeouts), webhook-sink.ts (delivery sink + gateway discovery)
scripts/          run-systemtest.ts
.github/workflows/systemtest.yml
```

## Phase 2 conventions worth knowing

- **Spec independence over shared state.** Specs that mutate a server's run state
  (stop it to fire an event, rename it, etc.) provision their **own** throwaway
  server rather than the worker `sharedServer`, so they cannot race the specs that
  need it running. Only read-only-on-run-state specs (`metrics`, `public-dashboard`)
  share it. The heavyweight Minecraft path is split: `server-from-template` creates
  its own server through the template UI (that UI is its feature); `rcon` uses the
  API-provisioned `minecraftServer` fixture — never a cross-file ordering dependency.
- **Webhook delivery networking.** The backend runs inside the compose network, so a
  sink on the runner host is NOT reachable at `localhost` from the container. The
  `webhookSink` fixture binds `0.0.0.0` and hands out a URL whose host is the Docker
  bridge gateway (discovered via `docker network inspect`; falls back to
  `172.17.0.1`). A delivery timeout message distinguishes "webhook broken" from
  "runner networking wrong". See `helpers/webhook-sink.ts`.
- **Hosted template/game APIs.** The compose install sets no template/games-api
  override, so `templates` and `games-search` hit the hosted public services — a
  hosted outage is expected to red exactly those two rows.
- **Wire format stays snake_case** in both directions for multi-word JSON fields (see
  `api.ts` banner). A few backend DTOs use single-word fields that are NOT converted
  (`RCONConfiguration.enabled/port/password`, `AccessGroupCreationDto.name`) — verify
  each field against the DTO, don't assume.
