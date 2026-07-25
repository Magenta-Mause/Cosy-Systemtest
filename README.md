# Cosy Systemtest

End-to-end system tests for [Cosy](https://github.com/Magenta-Mause/Cosy). On every
new version (nightly + on demand) they install Cosy from scratch via
`install_cosy.sh` on a throwaway GitHub-hosted runner — exactly like a real user —
drive each feature through the real web UI, and publish a per-feature pass/fail
matrix.

**Phase 2** (this state): the full feature matrix. Phase 1 delivered the install →
core lifecycle → uninstall path (`@core`); Phase 2 adds the remaining feature specs
(`@extended`). Nightly + manual trigger, results as a GitHub artifact (reporting
dry-run); a manual run can pin a specific backend/frontend image tag to verify a fix
before release (recorded as the `staging` channel — see
[below](#testing-a-specific-not-yet-released-build)). OTLP/SigNoz reporting and the
automatic staging trigger (`repository_dispatch` on image push) come in later phases. See [`Cosy/PLAN-systemtest.md`](https://github.com/Magenta-Mause/Cosy)
for the full roadmap.

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
npm run systemtest          # run the suite via the runner → results/summary.json
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
| `CI` | Enables CI reporters (github/html/json) + retries | — |

## How it runs in CI

`.github/workflows/systemtest.yml` (nightly `30 2 * * *` + `workflow_dispatch`):
checkout → Node 22 → `npm ci` → `playwright install --with-deps chromium` → install
Cosy → poll health (≤10 min) → run the suite → uninstall + assert clean teardown →
upload the report and results. The runner exits 0 even when features fail (metrics
are truth); the job only goes red on infrastructure errors.

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

## Documentation

- [docs/test-architecture.md](docs/test-architecture.md) — layers, install/credential flow, why a runner VM.
- [docs/testid-gaps.md](docs/testid-gaps.md) — `data-testid`s to add in the frontend (the suite has none to use yet).
- [CLAUDE.md](CLAUDE.md) — agent-facing conventions.
