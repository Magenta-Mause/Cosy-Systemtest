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
npm run systemtest   # runner → results/summary.json + push metrics & trace (exits 0 even on red tests)
npm run systemtest:nopush  # same, but write only — no OTLP push (what CI's suite step runs)
npm run systemtest:push    # push an existing results/summary.json (metrics + trace); runs no tests
npx tsx scripts/run-systemtest.ts --no-push --grep @core --fail-on-failure   # what a PR gate runs
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
| `SYSTEMTEST_RETRIES` | Overrides Playwright `retries`. PR gates set `1` (see docs/pr-gate.md); an unparseable or negative value is a hard error, never a silent fallback | — (2 on CI, 0 locally) |
| `COSY_CHANNEL` | Channel label in `results/summary.json`; the workflow sets `staging` when a manual run pinned an image tag, else `release` | `release` |
| `COSY_BACKEND_TAG` | Installed backend image tag, written to `summary.json` → `versions.backend` (workflow reads it back out of the installed `.env`) | — (`null` in the summary) |
| `COSY_FRONTEND_TAG` | Installed frontend image tag → `versions.frontend` | — (`null` in the summary) |
| `OTEL_INGEST_URL` | Base URL of the authenticated OTLP-HTTP ingest (SigNoz collector); the runner POSTs to `${OTEL_INGEST_URL}/v1/metrics` **and** `${OTEL_INGEST_URL}/v1/traces`. CI sets `https://otel-ingest.jannekeipert.de` (overridable via the `OTEL_INGEST_URL` repo variable) | — (push skipped) |
| `OTEL_INGEST_USER` | HTTP Basic user for the ingest (GitHub secret) | — (push skipped) |
| `OTEL_INGEST_PASSWORD` | HTTP Basic password for the ingest (GitHub secret) | — (push skipped) |
| `REPORTS_BASE_URL` | Host serving the uploaded Playwright HTML reports. Set **job-level** in the workflow (overridable via the repo variable of the same name) because the *suite* step is where `summary.json`'s `reportUrl` is computed — setting it on the push step alone silently does nothing | `https://systemtest-reports.jannekeipert.de` |
| `CI` | CI reporters + retries | — |

Workflow-only (the publish step reads them; the runner never does):
`MINIO_REPORTS_ENDPOINT` (repo variable, default `https://minio-cli.jannekeipert.de`)
and the `MINIO_REPORTS_ACCESS_KEY` / `MINIO_REPORTS_SECRET_KEY` repo secrets.

**The push is all-or-nothing on config:** unless all three `OTEL_INGEST_*` are set and
non-empty, the runner logs one INFO line and exits 0 — local runs and forks are
unaffected. When they *are* set, both signals (metrics + the run's trace) go out and a
failed push of *either* exits **1** (see convention 8).

## Hard conventions (do not break)

1. **Import `test` / `expect` only from `@fixtures/index`**, never from
   `@playwright/test`.
2. **No selectors in specs.** All selectors + UI actions live in `tests/pages/*`.
   Specs describe behaviour with `test.step('Given/When/Then …')`.
3. **`data-testid`s are owned by the Cosy frontend.** Since v1.1.0 the frontend ships
   Phase 1 of them, and page objects use `getByTestId` wherever an id exists. Sites
   with no id yet use accessible role/label selectors marked `// TODO(testid)`, and
   every gap is logged in [docs/testid-gaps.md](docs/testid-gaps.md). When you add an
   id in `Cosy-Frontend`, switch the page object to `getByTestId` and remove the gap
   row — do **not** invent ids only here.
   **Prefer a testid to a label for anything you click**: a loading Button REPLACES
   its children with a loading label, so a name-based locator stops matching mid-action.
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
   push of either signal** (metrics or trace; both are attempted, then the failures
   are reported together). A push that breaks quietly would leave the dashboard stale with nobody
   noticing, so it is loud and red. `results/summary.json` is always written *before*
   any push, so a failed push never costs us the results.
   **Writing and pushing are separate modes:** `--no-push` (run + write only) and
   `--push-only` (push an existing summary, no Playwright); no flag = both, the local
   default. CI runs them as two steps — see convention 10.
   **`--fail-on-failure` is the one explicit opt-out**, used only by the PR gates
   (convention 17), which must fail closed. It is a boolean flag and not a
   `--mode release|pr` string on purpose: a mistyped or defaulted mode string turns a
   blocking check into a no-op whose log looks perfectly healthy, whereas a forgotten
   flag can only produce a false green in the one place there is a second, independent
   check for it. Never make it the default, and never make the nightly pass it.
   **`--grep <pattern>`** forwards a tag expression to Playwright so a gate can run a
   subset; it is rejected together with `--push-only`, where it would silently do
   nothing.
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
    row appended by `.github/actions/run-systemtest` (the composite action that owns
    install → suite → teardown, shared with the PR gates — convention 17), not a spec.
    **The push therefore comes last:** the suite step runs `--no-push`, the teardown
    assertion appends the
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
    `staging`. The same values ride along on **`cosy_platform_systemtest_run_info`**
    (`cosy.backend.image_tag`, `cosy.frontend.image_tag`, `cosy.systemtest.run_url`,
    `…report_url`, `…trace_id`, `…run_at`) and on the **trace's** resource, so a run in
    SigNoz names its build and its run. Never drop those fields — a red row is
    meaningless without them.
    **Run-varying labels must stay OFF the per-feature metrics.** SigNoz materialises
    resource attributes as series labels, so a label that changes per run gives every
    run its own series, and then: `last_over_time(...[26h])` returns one sample per RUN
    instead of the latest run's (the count tiles read feature × run — 32 "failing" for
    ~5 red features over 6 runs), and `count_over_time(...) >= 2` can never be satisfied,
    which meant `CosySystemtestFeatureFailing` was structurally unable to fire. The
    per-feature metrics therefore carry ONLY `feature` + `channel`, and the metrics'
    resource carries only `service.name` + `deployment.environment`. If you need a new
    run-level dimension, add it to `run_info`, never to a feature metric.
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
    must wrap its metric in `last_over_time(...[26h])`, and every counting tile must
    also dedupe with `count by (feature)` (durations: `max by (feature)`) so it counts
    FEATURES, not series — otherwise a stray extra series per feature silently
    multiplies the number, which is exactly how the per-run-series bug went unnoticed: a nightly publishes one sample
    per day and Prometheus' 5-minute lookback would otherwise blank the dashboard
    minutes after a run. Alert rules live in the cluster deployment repo under
    `infrastructure/signoz-alerts/`. The "Runs in window" table is the drill-down panel:
    it is backed by `cosy_platform_systemtest_run_info` — the only metric carrying
    run-level labels, see convention 11 — groups by `cosy.systemtest.trace_id` and
    carries a SigNoz context link
    (`contextLinks.linksData`, url `/trace/{{_cosy.systemtest.trace_id}}`) — do not drop
    either, they are the only path from the dashboard into a run's trace. See the
    README's "The SigNoz dashboard" section. Its **first** groupBy entry is
    `cosy.systemtest.run_at` — the run's timestamp, ISO 8601 UTC at second precision —
    and it is also the table's `orderBy` (`desc`). Both positions are deliberate: SigNoz
    builds a table's columns in groupBy order (the backend emits `labelsArray` in the
    SELECT order it derives from groupBy), so leading with the timestamp makes the table
    read like a log; and an ISO 8601 UTC string of uniform width sorts lexicographically
    in exactly chronological order, which is why it can be the sort key at all. Do not
    sort this table on `cosy.systemtest.run_url` again — that ordered correctly only
    while GitHub run ids happened to be equal-width and monotonic. It also groups by
    `cosy.systemtest.report_url` and carries the matching "Watch this run's report"
    context link — see convention 16.
14. **One run = one trace, and a skip is never a green span.** The same `--push-only`
    step that pushes the metrics also POSTs one OTLP trace to `/v1/traces`: a root span
    `cosy-systemtest run (<channel>)` (ERROR if any feature failed, attributes
    `cosy.systemtest.features.total/.passed/.failed/.skipped`) with **one child span per
    feature** (`feature`, `channel`, `status`, `cosy.systemtest.duration_seconds`,
    `cosy.systemtest.timing`; failed → ERROR + the Playwright message, passed → OK).
    Rules that must not be broken:
    - **A skipped feature is a ZERO-LENGTH span named `<feature> [skipped]` with span
      status UNSET** — not OK (that would read as verified), not ERROR (nothing is
      broken), not omitted (a missing span is indistinguishable from a feature dropped
      from the suite). Same reasoning as convention 9 for the metrics.
    - **Timing is measured where it can be.** `parseReport` copies each spec's real
      `startTime`/`duration` from the Playwright JSON report into `summary.json`
      (`startedAt`/`endedAt`), and the spans are laid out on those (`timing=measured`).
      Rows without them — in practice only the `jq`-appended `uninstall` — are laid out
      sequentially after the last measured end and marked `timing=derived`. Never present
      a reconstructed position as measured; if you add a row, either give it real
      timestamps or leave it derived.
    - **Ids come from `crypto.randomBytes`** (16 bytes trace / 8 bytes span, lowercase
      hex), and every feature span sets `parentSpanId` to the root's id — a wrong id
      width or a missing parent shows up in SigNoz as orphan spans, not as an error.
    - The trace id also rides on `cosy_platform_systemtest_run_info` as the
      `cosy.systemtest.trace_id` data-point attribute (NOT on the per-feature metrics —
      see convention 11), which is what lets the dashboard link a run's row to
      `/trace/<id>`. Keep the two in sync — they are generated once per push.
15. **Known reds are excluded from paging, never from the suite.** Today the only
    exclusion is `rcon` (quarantined) in `CosySystemtestFeatureNotRunning` — a rule
    that fires every night forever gets muted and then misses the real regression. It
    is NOT skipped silently and NOT hidden on the dashboard, which shows the expected
    count explicitly. The `templates` / `server-from-template` exclusion that stood for
    the whole v1.0.3 line was removed when v1.1.0 shipped the create-wizard fix, along
    with the `CosySystemtestKnownBugFixed` rule that existed to prompt that removal.
    When you add or remove such an exclusion, change the rule, the panel and
    `docs/KNOWN-ISSUES.md` in one commit — and pair any new exclusion with a
    `KnownBugFixed`-style rule, or it becomes a blind spot nobody revisits.
16. **The hosted report URL is DERIVED, and the layout on disk must match it.** The
    workflow's "Publish Playwright report" step mirrors `playwright-report/` to
    `s3://cosy-systemtest-reports/<channel>/<github-run-id>/`, and
    `buildReportUrl()` independently composes
    `${REPORTS_BASE_URL}/<channel>/<GITHUB_RUN_ID>/index.html` for `summary.json`'s
    `reportUrl` → the `cosy.systemtest.report_url` attribute on
    `cosy_platform_systemtest_run_info` (and on the trace's resource). **Nothing
    connects the two but this convention** — change one path and every dashboard link
    404s while looking perfectly healthy. If you change the layout, change both in the
    same commit. Keep `/index.html` in the URL (MinIO serves objects, not directories)
    and keep the prefix per-run-id, not per-attempt: a re-run overwrites, because
    `run_url` has no attempt component either.
    - **The publish step must never fail the job.** It handles its own errors and exits
      0 with a `::warning::`; the report is a convenience on top of the artifacts, which
      are still uploaded. This is the deliberate opposite of the OTLP push (convention
      8), which *is* the signal and therefore *does* fail the job.
    - **It runs before the push step**, so the URL the metrics carry is already live.
    - **Only `playwright-report/` is published.** `results/` — stack diagnostics,
      container logs, `dmesg` — stays a private GitHub artifact; the bucket is public.
    - Bucket, lifecycle (30-day expiry), the write-only credential and the ingress are
      defined in `Janne6565/cluster-deployment` (`infrastructure/minio.yaml`,
      `infrastructure/cosy-systemtest-reports-ingress.yaml`), not here. The CI key can
      `PutObject` into that one bucket and nothing else — do not "fix" a permission
      error by widening it; expiry is the server's job, never CI's.

17. **The PR gate fails closed, and the nightly does not.** Three repositories gate
    their pull requests on this suite (Cosy-Frontend, cosy-backend, and this one) by
    calling `.github/actions/run-systemtest` — the composite action that owns
    install → suite → diagnostics → uninstall → teardown assertion. Read
    [docs/pr-gate.md](docs/pr-gate.md) before touching any of it. The rules that are
    easy to break by "simplifying":
    - **PR runs push NOTHING** — no OTLP, no MinIO. A `channel=pr` would fork
      `deployment.environment`, the report-bucket prefix and the trace root-span name,
      and give every run its own series (exactly what convention 11 forbids). The
      publish and push steps therefore live in `systemtest.yml`, *outside* the action —
      which also keeps the action provably secret-free, and it runs fork-authored
      Dockerfiles.
    - **The gate's authoritative check is the caller's `jq` allowlist** over
      `results/summary.json`, not `--fail-on-failure`. All six `@core` specs skip
      themselves when `INSTALL_LOG` is unset, so a dead install yields six skips, a
      green Playwright, a green runner and a green job — verified, not hypothetical.
      Only "every expected feature is present AND passed" catches it. Keep it in the
      caller workflows so it survives a refactor of the action.
    - **PR images are built locally and never pushed.** Cosy's compose file sets no
      `pull_policy`, so a locally tagged image wins. Three guards in the action assert
      that (image present before install; installed `.env` names our tag; running
      container has our image id) because each failure mode is otherwise GREEN. In
      particular `docker/build-push-action` needs **`load: true`** — without it the
      `docker-container` buildx driver leaves the image in the build cache and compose
      quietly pulls the published one.
    - **The required check is `systemtest-gate`, not `systemtest`.** A skipped job
      reports nothing and a required check that never reports blocks the PR forever.
      The gate job is green on success or on an *allowlisted* skip, red otherwise. Do
      not add `paths` filters to the gate workflows, and do not make it green on any
      skip.
    - **Sibling resolution never guesses.** Ambiguity is a hard error naming the
      PR-body override, because a silent fall back to `main` produces a green result
      for a combination nobody chose.

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
.github/workflows/systemtest.yml       nightly release run (owns the MinIO + OTLP steps)
.github/workflows/systemtest-pr.yml    this repo's own PR gate
.github/actions/run-systemtest/        install → suite → teardown; shared by all four
.github/actions/resolve-sibling-ref/   which sibling branch belongs to a PR (+ resolve.sh)
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
