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
npm run systemtest   # runner → results/summary.json (exits 0 even on red tests)
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
| `COSY_CHANNEL` | Channel label in `results/summary.json` | `release` |
| `CI` | CI reporters + retries | — |

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
   (metrics are truth); it fails only on infrastructure errors (no parseable report).
   OTLP push is a Phase-3 stub (`pushMetrics()` throws) — do not wire it in Phase 1.
9. **Install/uninstall belong to the workflow**, not to Playwright. `uninstall` is a
   workflow-appended row in `results/summary.json`, not a spec.

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
