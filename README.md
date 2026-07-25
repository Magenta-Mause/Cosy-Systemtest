# Cosy Systemtest

End-to-end system tests for [Cosy](https://github.com/Magenta-Mause/Cosy). On every
new version (nightly + on demand) they install Cosy from scratch via
`install_cosy.sh` on a throwaway GitHub-hosted runner — exactly like a real user —
drive each feature through the real web UI, and publish a per-feature pass/fail
matrix.

**Phase 3** (this state): the full feature matrix, reported to SigNoz. Phase 1
delivered the install → core lifecycle → uninstall path (`@core`); Phase 2 added the
remaining feature specs (`@extended`); Phase 3 pushes the per-feature results as OTLP
metrics (see [Reporting](#reporting-what-lands-in-signoz)). Nightly + manual trigger,
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
npm run systemtest:push     # push an existing results/summary.json — runs no tests
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
| `OTEL_INGEST_URL` | Base URL of the OTLP-HTTP ingest; the runner POSTs to `${OTEL_INGEST_URL}/v1/metrics` | — (push skipped) |
| `OTEL_INGEST_USER` | HTTP Basic user for the ingest | — (push skipped) |
| `OTEL_INGEST_PASSWORD` | HTTP Basic password for the ingest | — (push skipped) |
| `CI` | Enables CI reporters (github/html/json) + retries | — |

## How it runs in CI

`.github/workflows/systemtest.yml` (nightly `30 2 * * *` + `workflow_dispatch`):
checkout → Node 22 → `npm ci` → `playwright install --with-deps chromium` → install
Cosy → poll health (≤10 min) → run the suite (`--no-push`, writes
`results/summary.json`) → capture diagnostics → uninstall + assert clean teardown
(appends the `uninstall` row) → **push metrics to SigNoz** (`--push-only`) → upload
the report and results. The runner exits 0 even when features fail (metrics are
truth); the job only goes red on infrastructure errors — including a failed metric
push (see [Reporting](#reporting-what-lands-in-signoz)). The ingest URL comes from
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
`cosy_systemtest_last_run_timestamp_seconds`. That is preferable to pushing twice per
run just to cover it, which would put a second, `uninstall`-less matrix on the
dashboard every night.

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
authenticated OTLP-HTTP ingest (`${OTEL_INGEST_URL}/v1/metrics`, HTTP Basic) which
fronts the SigNoz collector. All five metrics are gauges, written once per run:

| Metric | Attributes | Meaning |
|---|---|---|
| `cosy_systemtest_feature_status` | `feature`, `channel` | `1` passed, `0` failed. **Skipped features are not reported here.** |
| `cosy_systemtest_feature_skipped` | `feature`, `channel` | `1` the feature did not run, `0` it ran |
| `cosy_systemtest_feature_duration_seconds` | `feature`, `channel` | Wall-clock seconds; skipped features are absent |
| `cosy_systemtest_run_success` | `channel` | `1` if no feature failed, else `0` |
| `cosy_systemtest_last_run_timestamp_seconds` | `channel` | Unix time of the run — the staleness signal |

Resource attributes on every data point: `service.name=cosy-systemtest`,
`deployment.environment=<channel>`, `cosy.backend.image_tag`,
`cosy.frontend.image_tag` and `cosy.systemtest.run_url` — so any point names the
build it tested and links back to the GitHub run (and from there to the HTML report,
traces and videos).

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

**Dry-run behaviour (local runs and forks).** The push happens only when
`OTEL_INGEST_URL`, `OTEL_INGEST_USER` and `OTEL_INGEST_PASSWORD` are all set and
non-empty. Otherwise the runner prints one INFO line, leaves `results/summary.json`
as the complete result, and exits 0 — so `npm run systemtest` on a laptop or in a
fork (where secrets are not exposed) behaves exactly as it did before.

**A failed push fails the job.** Red features never fail the runner, but a push that
fails — bad credentials, ingest down, a `200` whose body reports rejected data points,
or a `results/summary.json` that is missing or malformed — exits non-zero with a
`::error::` annotation, after three attempts. A reporting path that breaks silently
would leave the dashboard stale with nobody noticing, which is the failure mode this
reporting exists to prevent. The summary is written by an earlier step, so the results
artifact survives a failed push intact.

## Documentation

- [docs/test-architecture.md](docs/test-architecture.md) — layers, install/credential flow, why a runner VM.
- [docs/testid-gaps.md](docs/testid-gaps.md) — `data-testid`s to add in the frontend (the suite has none to use yet).
- [CLAUDE.md](CLAUDE.md) — agent-facing conventions.
