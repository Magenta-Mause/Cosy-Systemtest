# Cosy Systemtest

End-to-end system tests for [Cosy](https://github.com/Magenta-Mause/Cosy). On every
new version (nightly + on demand) they install Cosy from scratch via
`install_cosy.sh` on a throwaway GitHub-hosted runner — exactly like a real user —
drive each feature through the real web UI, and publish a per-feature pass/fail
matrix.

**Phase 1** (this state): repo scaffold + workflow + the install → core lifecycle →
uninstall specs, on the **release** channel, nightly + manual trigger. Results are a
GitHub artifact (reporting dry-run); OTLP/SigNoz reporting and the staging channel
come in later phases. See [`Cosy/PLAN-systemtest.md`](https://github.com/Magenta-Mause/Cosy)
for the full roadmap.

## Features covered (Phase 1)

| Feature (`@core`) | Proves, as the user |
|---|---|
| `install` | Fresh install → stack healthy (`/api/actuator/health`), UI reachable, printed admin credentials valid and matching `.env` |
| `auth` | Login with the parsed credentials, token refresh survives reload, logout |
| `server-create` | Create a server with a custom image (`halftheopposite/tosios`, 512 MiB) through the UI wizard → RUNNING |
| `server-lifecycle` | Stop → start via UI with live status over the WebSocket, then delete |
| `console` | Live log stream shows container output |
| `files` | File browser: create / rename / delete a directory (+ edit a text file if present) |
| `uninstall` | Asserted by the workflow (no leftover containers/dirs), not a spec |

## Commands

```bash
npm install                 # install deps (Node >= 22)
npm test                    # run the whole suite (chromium)
npm run test:core           # run @core-tagged specs (all of them, in Phase 1)
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
| `INSTALL_DIR` | Cosy install dir — `.env` is read from `${INSTALL_DIR}/config/.env` | `/opt/cosy` |
| `COSY_CHANNEL` | Channel label written into `results/summary.json` | `release` |
| `CI` | Enables CI reporters (github/html/json) + retries | — |

## How it runs in CI

`.github/workflows/systemtest.yml` (nightly `30 2 * * *` + `workflow_dispatch`):
checkout → Node 22 → `npm ci` → `playwright install --with-deps chromium` → install
Cosy → poll health (≤10 min) → run the suite → uninstall + assert clean teardown →
upload the report and results. The runner exits 0 even when features fail (metrics
are truth); the job only goes red on infrastructure errors.

## Documentation

- [docs/test-architecture.md](docs/test-architecture.md) — layers, install/credential flow, why a runner VM.
- [docs/testid-gaps.md](docs/testid-gaps.md) — `data-testid`s to add in the frontend (the suite has none to use yet).
- [CLAUDE.md](CLAUDE.md) — agent-facing conventions.
