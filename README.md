# Cosy Systemtest

End-to-end system tests for [Cosy](https://github.com/Magenta-Mause/Cosy). On every
new version (nightly + on demand) they install Cosy from scratch via
`install_cosy.sh` on a throwaway GitHub-hosted runner — exactly like a real user —
drive each feature through the real web UI, and publish a per-feature pass/fail
matrix.

**Phase 3** (this state): the full feature matrix, reported to SigNoz. Phase 1
delivered the install → core lifecycle → uninstall path (`@core`); Phase 2 added the
remaining feature specs (`@extended`); Phase 3 pushes the per-feature results as OTLP
metrics plus one trace per run (see [Reporting](#reporting-what-lands-in-signoz)).
Nightly + manual trigger,
results also kept as a GitHub artifact; a manual run can pin a specific
backend/frontend image tag to verify a fix before release (recorded as the `staging`
channel — see [below](#testing-a-specific-not-yet-released-build)). The automatic
staging trigger (`repository_dispatch` on image push) comes in a later phase. See
[`Cosy/PLAN-systemtest.md`](https://github.com/Magenta-Mause/Cosy) for the full
roadmap.

## Features covered

### Core (`@core`) — install → lifecycle → uninstall

| Feature | Proves, as the user |
|---|---|
| `install` | Fresh install → stack healthy (`/api/actuator/health`), UI reachable, printed admin credentials valid and matching `.env` |
| `auth` | Login with the parsed credentials, token refresh survives reload, logout |
| `server-create` | Create a server with a custom image (`halftheopposite/tosios`, 512 MiB) through the UI wizard → RUNNING |
| `server-lifecycle` | Stop → start via UI with live status over the WebSocket, then delete |
| `console` | Live log stream shows container output |
| `files` | File browser: create / rename / delete a directory (+ edit a text file if present) |
| `uninstall` | Asserted by the workflow (no leftover containers/dirs), not a spec |

### Extended (`@extended`) — full feature matrix

| Feature | Proves, as the user |
|---|---|
| `invites` | Admin creates an invite → redeemed in a 2nd unauthenticated context → new user logs in and lands in the UI |
| `user-management` | Set a quota user's docker-limits, change role, delete — via the users UI |
| `logs-history` | Loki-backed history returns lines the (now stopped) container produced |
| `metrics` | Metrics page renders the CPU/Memory series (InfluxDB) with data points |
| `templates` | Create wizard's catalog (hosted template API) loads the known games + their templates |
| `games-search` | Game search returns results with artwork (hosted game API → SteamGridDB) |
| `server-from-template` | Create a Minecraft server (itzg) from the template flow → reaches ready |
| `rcon` | Enable RCON via settings UI → send `list` in the console → RCON response appears |
| `webhooks` | Create an n8n webhook in the UI → trigger the event → a local HTTP sink receives it |
| `access-management` | Access group + limited member permissions → restricted user actually restricted in the UI |
| `public-dashboard` | Configured public dashboard renders for a fresh **unauthenticated** viewer (`?view=public`) |
| `settings-design` | General settings (server name) + server-card design persist across reload |
| `event-stream-resilience` | After several servers are **deleted while their containers run**, a normal stop on a surviving server is still observed by the backend — the regression guard for the lost Docker event stream |

**About `event-stream-resilience`.** It is the one spec that provokes a failure instead of
waiting to meet one. It brings a control server to RUNNING (proving the backend's Docker
`/events` stream is alive), then deletes ten other RUNNING servers at once — their `die`
events then reach the backend for game servers whose rows are already gone, which is
exactly what ends the released backend's `/events` subscription (a 404 from the status
supplier, an `ObjectOptimisticLockingFailureException` from the status write, or a 404
from the webhook dispatch, escaping into the docker-java callback). Finally it stops the
surviving control server and requires `STOPPED` within a short budget. It costs ~4 minutes
and runs every night, because the bug class it guards freezes every server in a
transitional state until the backend is restarted (see
[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)). Against a backend that still has the bug it
*causes* the wedge, so later specs fail too — fast and with the same named diagnosis.
Skip it for a run with
`npx playwright test --grep-invert event-stream-resilience`.

`@extended` specs are tagged, not selected by a file list; `npm run test:extended`
runs them, `npm run test:core` runs the core set, `npm test` runs everything. The
runner records one result row per spec file regardless of tag.

**Hosted-service dependency:** the single-host docker-compose install ships no
`cosy.templates-api.url` / `cosy.games-api.url` override, so the backend uses its
`application.yaml` defaults, which point at the **hosted** public services
(`cosy-templates.jannekeipert.de`, `cosy-game-api.jannekeipert.de`). `templates` and
`games-search` therefore exercise that real user path — a hosted-API outage reds
exactly those two rows (intended), not the suite.

## Commands

```bash
npm install                 # install deps (Node >= 22)
npm test                    # run the whole suite (chromium)
npm run test:core           # run @core-tagged specs (install → lifecycle → uninstall)
npm run test:extended       # run @extended-tagged specs (the rest of the matrix)
npm run typecheck           # tsc --noEmit
npm run systemtest          # run the suite via the runner → results/summary.json, then push
npm run systemtest:nopush   # run + write results/summary.json only (what CI's suite step does)
npm run systemtest:push     # push an existing results/summary.json (metrics + trace) — runs no tests
npm run report              # open the last HTML report
```

`npx playwright test --list` lists every spec even without an install present — the
install-gated specs skip with a uniform reason rather than erroring.

## Running locally against an existing Cosy install

The suite talks to a running Cosy over `COSY_BASE_URL` (default
`http://localhost:8080`) and reads the admin credentials from the installer log +
`.env`. Point it at an install you already have:

```bash
export COSY_BASE_URL=http://localhost:8080   # your Cosy URL
export INSTALL_LOG=/path/to/install.log      # the tee'd installer stdout
export INSTALL_DIR=/opt/cosy                 # install dir (for the .env cross-check)
npm test
```

Without `INSTALL_LOG` set, every spec self-skips (uniform reason) so the suite stays
listable and typecheckable on any machine.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `COSY_BASE_URL` | Target Cosy URL | `http://localhost:8080` |
| `INSTALL_LOG` | Path to the tee'd installer stdout (admin creds source; gates all specs) | — (specs skip if unset) |
| `INSTALL_DIR` | Cosy install dir — `.env` fallback is read from `${INSTALL_DIR}/config/.env` | `/opt/cosy` |
| `INSTALL_ENV_FILE` | Runner-readable copy of the installed `.env`, preferred over `INSTALL_DIR` (the installed file is root-owned chmod 600, so CI copies it) | — (falls back to `INSTALL_DIR`) |
| `COSY_CHANNEL` | Channel label written into `results/summary.json` (`release`, or `staging` when a run pinned an image tag) | `release` |
| `COSY_BACKEND_TAG` | Installed backend image tag, recorded as `versions.backend` in the summary | — (`null`) |
| `COSY_FRONTEND_TAG` | Installed frontend image tag, recorded as `versions.frontend` in the summary | — (`null`) |
| `OTEL_INGEST_URL` | Base URL of the OTLP-HTTP ingest; the runner POSTs to `${OTEL_INGEST_URL}/v1/metrics` and `${OTEL_INGEST_URL}/v1/traces` | — (push skipped) |
| `OTEL_INGEST_USER` | HTTP Basic user for the ingest | — (push skipped) |
| `OTEL_INGEST_PASSWORD` | HTTP Basic password for the ingest | — (push skipped) |
| `REPORTS_BASE_URL` | Host serving the [hosted HTML reports](#hosted-html-reports); the runner derives `summary.json` → `reportUrl` from it | `https://systemtest-reports.jannekeipert.de` |
| `CI` | Enables CI reporters (github/html/json) + retries | — |

CI-only, read by the workflow's publish step rather than by the runner:
`MINIO_REPORTS_ENDPOINT` (repo variable, default `https://minio-cli.jannekeipert.de`)
plus the `MINIO_REPORTS_ACCESS_KEY` / `MINIO_REPORTS_SECRET_KEY` repo secrets. Without
the two secrets the step logs one INFO line and skips — forks are unaffected.

## How it runs in CI

`.github/workflows/systemtest.yml` (nightly `30 2 * * *` + `workflow_dispatch`):
checkout → Node 22 → `npm ci` → `playwright install --with-deps chromium` → install
Cosy → poll health (≤10 min) → run the suite (`--no-push`, writes
`results/summary.json`) → capture diagnostics → uninstall + assert clean teardown
(appends the `uninstall` row) → **publish the HTML report**
([below](#hosted-html-reports)) → **push metrics + the run's trace to SigNoz**
(`--push-only`) → upload the report and results. The runner exits 0 even when features
fail (metrics are truth); the job only goes red on infrastructure errors — including a
failed push (see [Reporting](#reporting-what-lands-in-signoz)). The ingest URL comes from
the `OTEL_INGEST_URL` repo variable (defaulting to
`https://otel-ingest.jannekeipert.de`) and the credentials from the
`OTEL_INGEST_USER` / `OTEL_INGEST_PASSWORD` repo secrets, passed to the push step via
`env:` — never interpolated into a shell command.

**Why the push is a separate, final step.** `uninstall` is asserted by the workflow
*after* the suite and appended to `results/summary.json`. When the suite step also
pushed, that row was written too late to be included and SigNoz saw 19 of the 20
features while the artifact had all 20 — a dashboard that quietly misrepresented the
matrix. Writing and pushing are now separate modes of the same runner, and the push
runs last with `if: always()`. The accepted cost: if the whole job hits its
`timeout-minutes`, GitHub cancels the remaining steps and that run reports nothing
(it loses the results artifact for the same reason) — visible as a stale
`cosy_platform_systemtest_last_run_timestamp_seconds`. That is preferable to pushing
twice per run just to cover it, which would put a second, `uninstall`-less matrix on
the dashboard every night.

### Testing a specific, not-yet-released build

A manual run takes three optional inputs — `backend_tag`, `frontend_tag` (ghcr image
tags such as `sha-abc1234`) and `config_ref` (a git ref of `Magenta-Mause/Cosy` the
compose/config files are fetched from). Each is forwarded to `install_cosy.sh` as
`--backend-tag` / `--frontend-tag` / `--config-ref` only when non-empty, so leaving
the form untouched installs the published, pinned versions.

```bash
gh workflow run systemtest.yml --repo Magenta-Mause/Cosy-Systemtest \
  -f reason="verify backend fix #123" \
  -f backend_tag=sha-abc1234
```

Any override switches the summary's `channel` from `release` to `staging`. Whatever
was installed is read back out of the generated `.env` and stored in
`results/summary.json` under `versions` (`backend` / `frontend`), so every stored
result says which build it tested.

## Reporting: what lands in SigNoz

Once the suite has run *and* the workflow has asserted the teardown, the runner POSTs
the complete results — every spec row plus the workflow's `uninstall` row — to the
authenticated OTLP-HTTP ingest (HTTP Basic) which fronts the SigNoz collector. **Two
signals go out per run**, from the same `--push-only` step and sharing one trace id:

- **metrics** → `${OTEL_INGEST_URL}/v1/metrics` — the time series the dashboard and the
  alert rules are built on ("has this feature been red two nights running?");
- **one trace** → `${OTEL_INGEST_URL}/v1/traces` — the run as a timeline
  ([below](#the-run-trace-one-run-one-trace)): what ran when, how long each feature
  took, which failed and with what message.

### Metrics

All six metrics are gauges, written once per run:

| Metric | Attributes | Meaning |
|---|---|---|
| `cosy_platform_systemtest_feature_status` | `feature`, `channel` | `1` passed, `0` failed. **Skipped features are not reported here.** |
| `cosy_platform_systemtest_feature_skipped` | `feature`, `channel` | `1` the feature did not run, `0` it ran |
| `cosy_platform_systemtest_feature_duration_seconds` | `feature`, `channel` | Wall-clock seconds; skipped features are absent |
| `cosy_platform_systemtest_run_success` | `channel` | `1` if no feature failed, else `0` |
| `cosy_platform_systemtest_last_run_timestamp_seconds` | `channel` | Unix time of the run — the staleness signal |
| `cosy_platform_systemtest_run_info` | `channel`, `cosy.backend.image_tag`, `cosy.frontend.image_tag`, `cosy.systemtest.run_at` / `…run_url` / `…report_url` / `…trace_id` | Always `1`. Carries the run-level labels; backs the "Runs in window" table |

**Run-level labels live on `run_info` only — never on a per-feature metric.** SigNoz
materialises attributes as series labels, so a label that changes per run (a trace id, a
run URL, an image tag across a release) gives every run its **own series**. Two things
then break, both silently:

- `last_over_time(...[26h])` returns one sample **per run** rather than the latest run's,
  so the dashboard's count tiles read *feature × run* — 32 "failing" for ~5 red features
  across 6 runs.
- `count_over_time(...) >= 2` can never be satisfied, because one run writes exactly one
  sample per series. That is the "two consecutive runs" clause in
  `CosySystemtestFeatureFailing`, which therefore could not fire **at all**.

Hence the split: per-feature metrics carry only `feature` + `channel`, the metrics'
resource carries only `service.name` + `deployment.environment`, and everything that
identifies the run sits on `run_info` (and on the trace's resource, where per-run
identity is the whole point). Successive runs then append to the same series, and
`last_over_time` means what it says: **the latest run**.


**Why the names start with `cosy_platform_`, not just `cosy_`.** The obvious
`cosy_systemtest_*` namespace is already occupied in the same SigNoz instance by the
**Cosy Domain Provider** systemtest — a different product, reporting via Pushgateway →
Prometheus remote_write, with a Grafana dashboard and alert rules already built on
`cosy_systemtest_run_success` and friends. Two products under one metric name means
every panel and alert silently merges both, and a failure over there would page for
this repo (or the reverse). `cosy_platform_` states the subject: the Cosy **game-server
platform**. Keep the prefix on every metric added here — do not shorten it back.

The **metrics'** resource is deliberately minimal — `service.name=cosy-systemtest` and
`deployment.environment=<channel>`, both stable across runs (see the note above on why).
Everything identifying a run — `cosy.backend.image_tag`, `cosy.frontend.image_tag`,
`cosy.systemtest.run_url`, `…report_url`, `…trace_id`, `…run_at` — rides on
`cosy_platform_systemtest_run_info` as data-point attributes, and on **every span of the
run's trace** as resource attributes, where per-run identity is the whole point.
Between them a run still names the build it tested, links back to the GitHub run, opens
the run's hosted HTML report (videos and traces included), names the SigNoz trace of the same run,
and says when the run reported.

`cosy.systemtest.run_at` is `summary.generatedAt` (the moment the summary was written,
right after the suite) rendered as **ISO 8601 UTC at second precision** —
`2026-07-25T15:42:15Z`. The format is a contract, not a style choice: the "Runs in
window" table both shows this column and sorts on it, and a lexicographic sort equals a
chronological one only while every value has the same width and the same zone. Do not
switch it to milliseconds or to a local offset.

**How a skip is represented, and why.** A skipped feature is *untested*, which is
neither a pass nor a failure. Reporting it as `1` would claim a feature works when
nothing checked it; reporting `0` would page for a product that may be perfectly
healthy. So a skip is **omitted** from `feature_status` and from
`feature_duration_seconds` (a `0` there would show up as "the feature got faster"),
and is stated explicitly by `feature_skipped=1`. Every feature — skipped or not —
reports `feature_skipped`, so a feature that quietly stops running is visible as a
`1` instead of vanishing from the dashboard. Consequently `run_success` means only
"nothing failed": read it together with `feature_skipped`, never alone.

`uninstall` is the one row asserted by the workflow rather than by a spec; the push
step runs after that assertion, so it is reported exactly like every other feature.

### The run trace: one run, one trace

The metrics say *whether* a feature passed; the trace says *when it ran, for how long,
in what order, and what the failure said*. Each run emits exactly one trace:

| Span | Name | Attributes | Status |
|---|---|---|---|
| Root | `cosy-systemtest run (<channel>)` | `channel`, `cosy.systemtest.features.total` / `.passed` / `.failed` / `.skipped` | ERROR if any feature failed (message lists them), else OK |
| Child (one per feature) | the feature key, e.g. `server-lifecycle` | `feature`, `channel`, `status`, `cosy.systemtest.duration_seconds`, `cosy.systemtest.timing` | failed → ERROR with the Playwright message; passed → OK; skipped → UNSET |

**Finding a run's trace.** Three ways, in order of convenience:

1. On the SigNoz dashboard, in **"Runs in window"**, click the run's row → **"Open this
   run's trace"** (a panel context link to `/trace/<traceId>`).
2. Copy the `cosy.systemtest.trace_id` column from that same table into the Traces
   explorer's trace-id search, or straight into
   `https://signoz.jannekeipert.de/trace/<traceId>`.
3. Traces explorer → filter `service.name = cosy-systemtest` (add
   `deployment.environment = release`) and pick the run by time. The GitHub workflow log
   of the push step also prints the trace id and the ready-made link.

**Timing is measured, not invented — where it can be.** The runner copies each spec's
real `startTime`/`duration` out of the Playwright JSON report into `results/summary.json`
(`startedAt` / `endedAt`) when it writes the summary, and the trace is laid out on those
timestamps; such spans carry `cosy.systemtest.timing=measured`. Rows that have no
measured window — in practice only `uninstall`, which the workflow appends with `jq`
after the suite — are placed sequentially starting at the last measured end and marked
`cosy.systemtest.timing=derived`. That position is truthful in order but not measured to
the second, and the attribute says so. (If a summary carries no timestamps at all, the
whole run is reconstructed back-to-back ending at `generatedAt`; the suite runs serially
in CI with `workers: 1`, so sequential is the honest reconstruction — and every span is
then marked `derived`.)

**How a skip looks in the trace.** A skipped feature is emitted as a **zero-length span
named `<feature> [skipped]` with span status UNSET** and `status=skipped` — never OK,
because OK would claim something was verified. It is *not* omitted: a missing span would
be indistinguishable from a feature that was quietly dropped from the suite, which is
exactly the failure the `feature_skipped` metric exists to prevent. Consequently a root
span can be OK while features were skipped — read the root's `features.skipped`
attribute, exactly as `run_success` must be read together with `feature_skipped`.

**Dry-run behaviour (local runs and forks).** The push happens only when
`OTEL_INGEST_URL`, `OTEL_INGEST_USER` and `OTEL_INGEST_PASSWORD` are all set and
non-empty. Otherwise the runner prints one INFO line, leaves `results/summary.json`
as the complete result, and exits 0 — so `npm run systemtest` on a laptop or in a
fork (where secrets are not exposed) behaves exactly as it did before.

**A failed push fails the job.** Red features never fail the runner, but a push that
fails — bad credentials, ingest down, a `200` whose body reports rejected data points or
spans, or a `results/summary.json` that is missing or malformed — exits non-zero with a
`::error::` annotation, after three attempts per signal. **Both** signals are attempted
even if the first fails (half the picture beats none), and a failure in either fails the
job. A reporting path that breaks silently
would leave the dashboard stale with nobody noticing, which is the failure mode this
reporting exists to prevent. The summary is written by an earlier step, so the results
artifact survives a failed push intact.

### Hosted HTML reports

A red cell on the dashboard should be one click from *watching what happened*, not a
zip download that expires. Every run's Playwright HTML report — the failure messages,
the screenshots, a `.webm` video of each test and its full trace — is therefore
uploaded to an object store and served at a stable URL:

```
https://systemtest-reports.jannekeipert.de/<channel>/<github-run-id>/index.html
```

`<channel>` is `release` or `staging` (the same value the metrics carry as `channel` /
`deployment.environment`); `<github-run-id>` is the id already inside
`cosy.systemtest.run_url`, so the two links reproduce one another by hand. The runner
puts the full URL in `results/summary.json` (`reportUrl`) and pushes it as the
`cosy.systemtest.report_url` attribute on `cosy_platform_systemtest_run_info`, which the
dashboard's **"Runs in window"** table shows as a column and offers as the **"Watch this run's report"**
context link.

The URL is **derived**, not reported back from the upload: `buildReportUrl()` composes
it from `REPORTS_BASE_URL`, the channel and `GITHUB_RUN_ID`. That keeps the link
identical no matter which step computes it, at the cost that a failed upload leaves a
404 behind — which the publish step warns about loudly. `/index.html` is part of the
URL because the store serves objects, not directories. A **re-run** of the same GitHub
run overwrites its own prefix rather than adding an `attempt-N` segment: `run_url` has
no attempt component either, so an attempt-scoped path could not be derived from what
the metrics carry, and both signals then agree on describing the latest attempt.

**Retention: 30 days**, enforced by a bucket lifecycle rule on the server (not by CI,
which holds no delete permission). That is more than double the 14-day GitHub artifact
retention it supersedes and long enough to compare a regression against a month of
green nights. Rows older than 30 days on the dashboard link to a report that 404s —
expected, not a fault.

**Access: public read.** A report shows the UI of a *throwaway* Cosy instance — a
container on a GitHub-hosted runner at `localhost:8080` that the same job's uninstall
step destroys — and the product itself is open source, so nothing in it is both secret
and durable. Worth knowing: Playwright traces record what tests typed, which includes
that instance's generated admin password; it authenticates against a machine that no
longer exists, and it is the reason to revisit this decision the moment a spec ever
exercises a *real* external credential. Anonymous access is read-only and confined to
this one bucket. The stack diagnostics (container logs, `dmesg`, `docker stats`) are
deliberately **not** published — they stay a private GitHub artifact.

**The upload never fails the job.** Hosting is a convenience layered on top of the
artifacts, which are still uploaded; a briefly unreachable object store must not turn a
green product run red and train everyone to ignore the colour. The step retries, then
emits a `::warning::` naming the reason and the URL that will 404. (Contrast the OTLP
push, which *does* fail the job — that path is the signal itself, not a copy.)

The bucket, its lifecycle rule, the write-only credential and the ingress live in the
cluster GitOps repo (`Janne6565/cluster-deployment`, `infrastructure/minio.yaml` and
`infrastructure/cosy-systemtest-reports-ingress.yaml`). CI authenticates with a MinIO
key scoped to `PutObject` on that single bucket: it cannot read objects back, cannot
delete, and cannot see any other bucket.

## The SigNoz dashboard

[docs/signoz-dashboard.json](docs/signoz-dashboard.json) is the version-controlled
definition of the **"Cosy Systemtest"** dashboard on
[signoz.jannekeipert.de](https://signoz.jannekeipert.de). **This file is the source of
truth** — SigNoz stores dashboards in its own database, so a change clicked together in
the UI exists nowhere else until it is exported back here.

**Import (first time):** SigNoz → *Dashboards* → *New dashboard* → *Import JSON* →
paste the file → *Import and next*.

**Update:** open the dashboard → *⋮* (top right) → *Edit JSON*, replace the contents,
save. Importing the file again instead creates a **second** dashboard with the same
name, which is how you end up with two half-maintained copies.

**Export after any UI edit:** *⋮* → *Export JSON*, write it over `docs/signoz-dashboard.json`
and commit it in the same change. A UI-only edit is a silent fork of this file.

**Merging a PR that touches this file changes nothing on its own** — SigNoz reads its own
database, not this repo. The *Update* step above is what applies it, and it is easy to
forget because everything looks committed and done.

**Order matters when a change also touches the metrics.** If a panel starts using a
metric that the runner does not emit yet, apply it in this order:

1. merge the code change,
2. let one run push (nightly, or dispatch one manually),
3. *then* update the dashboard JSON in SigNoz.

Do it the other way round and the new panel is simply empty, which reads like a broken
query rather than missing data. The reverse — updating the runner but not the dashboard —
leaves the old panel querying a label that no longer exists, which reads as "no data" for
the same reason.

What is on it:

| Section | Answers |
|---|---|
| Release channel — current state | Is the published product healthy *right now*? Passing / failing / **unexpected failures** / skipped / features reported / hours since the last run |
| Feature × time — release | *When* did a feature break, and for how long? A stacked band per failing feature, plus per-feature status and skip history |
| Duration trends | Is anything getting slower? Per-feature duration over time, suite total, slowest feature, count over 120 s |
| Build under test & drill-down | Which images produced this result, when did it run, and what did the run look like? Per-run table of `cosy.systemtest.run_at` (the sort key, newest first) / `cosy.backend.image_tag` / `cosy.frontend.image_tag` / the GitHub run URL / `cosy.systemtest.trace_id` — so a red cell is attributable to a build and a time, one click from the report and video, and one click from **"Open this run's trace"** (see below) |
| Staging channel | Will the *next* release break this? Same view for pre-release `sha-<short>` builds |
| Known expected skips | The one intentional skip (`rcon`), stated explicitly rather than left to look like breakage |

**From the dashboard to the run's trace.** The "Runs in window" table groups by
`cosy.systemtest.trace_id` (an attribute the runner puts on
`cosy_platform_systemtest_run_info`, holding the id of the trace the same run emitted) and carries a SigNoz **context link**:
click a row → *Open this run's trace* → `/trace/{{_cosy.systemtest.trace_id}}`, i.e. the
trace-detail page of that exact run. The id is also visible as a column, so it works by
copy-paste when the context menu is not available. Context links are a v5-dashboard
feature of SigNoz ≥ 0.13x — the panel JSON field is `contextLinks.linksData`.

**Every query wraps its metric in `last_over_time(...[26h])`, on purpose.** A nightly
publishes exactly one sample per feature per day; Prometheus' 5-minute lookback would
blank the entire dashboard five minutes after a run finished. The 26 h window carries the
last run forward so one nightly sample draws a full day-wide step.

**The dashboard is expected to show 0 reds and 1 skip.** `rcon` is quarantined and is
documented in [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md), which every affected panel's
description links to. Rather than hide it, the dashboard states it: the *Known expected
skips* row shows the expected count so a drift in either direction is obvious, and the
skip is reported as a skip rather than a pass. Nothing is suppressed to make the
dashboard look green.

Through the v1.0.3 line `templates` and `server-from-template` were *expected* reds on a
confirmed product bug, and both the "Unexpected failures (release)" tile and the paging
rule excluded them. **v1.1.0 shipped the fix and those exclusions were removed**, so
that tile now simply counts failures and every red means something broke.

### Alerts

Four SigNoz rules deliver through the existing `n8n-webhook` channel → n8n →
mail-service → email. (A fifth, `CosySystemtestKnownBugFixed`, existed only to flag when
the v1.0.3 known-bug exclusion could be dropped; v1.1.0 shipped the fix, so the rule did
its job and was deleted.) Their JSON lives in the cluster deployment repo under
`infrastructure/signoz-alerts/` (house convention), not here:

| Rule | Severity | Fires when |
|---|---|---|
| `CosySystemtestFeatureFailing` | critical | A feature failed in **every** release run of the last 28 h (≥ 2 runs). One flaky night does not page: the previous run's pass is still inside the window. No feature is excluded. |
| `CosySystemtestStale` | warning | No release run reported for > 26 h — the nightly is at 02:30 UTC, so this means one was missed entirely. Includes a No-Data condition; a silent dashboard must not read as a calm one. |
| `CosySystemtestStagingFeatureFailing` | info | A feature failed on the latest pre-release build. Notification-only — a broken *next* version is a heads-up, not an incident. |
| `CosySystemtestFeatureNotRunning` | warning | A feature reported `feature_skipped=1` in every run of the last 28 h, i.e. it silently stopped being tested. Excludes `rcon`. |

If you quarantine a feature or a new known bug appears, update the exclusions in those
rules **and** in the "Unexpected failures" panel in the same change as
[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — an exclusion nobody remembers is an
untested feature nobody notices.

## Documentation

- [docs/test-architecture.md](docs/test-architecture.md) — layers, install/credential flow, why a runner VM.
- [docs/testid-gaps.md](docs/testid-gaps.md) — which `data-testid`s the frontend ships (Phase 1, since v1.1.0) and which are still missing.
- [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — released-product behaviours and the two confirmed product bugs behind the expected reds.
- [docs/signoz-dashboard.json](docs/signoz-dashboard.json) — the SigNoz dashboard definition (import/update instructions above).
- [CLAUDE.md](CLAUDE.md) — agent-facing conventions.
