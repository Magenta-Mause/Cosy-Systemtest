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
6. **Suite selection is by Playwright tags** (`@core`), not npm-script file lists.
   Tag every new spec; add its feature key to the matrix in the README.
7. **Skip guard:** install-gated specs call `runsOnlyWithInstall()` in the describe
   body so they stay listable without an install and skip with one uniform reason.
8. **Runner semantics:** `scripts/run-systemtest.ts` exits 0 even when features fail
   (metrics are truth); it fails only on infrastructure errors (no parseable report).
   OTLP push is a Phase-3 stub (`pushMetrics()` throws) — do not wire it in Phase 1.
9. **Install/uninstall belong to the workflow**, not to Playwright. `uninstall` is a
   workflow-appended row in `results/summary.json`, not a spec.

## Layout

```
tests/specs/      one spec file per feature (install, auth, server-create, …)
tests/pages/      page objects (login, home, create-server, server-detail, console, files)
tests/fixtures/   custom test/expect, runsOnlyWithInstall, adminCreds/apiClient/sharedServer/loggedInPage
tests/helpers/    install.ts (cred parsing), api.ts (typed client), constants.ts (urls + timeouts)
scripts/          run-systemtest.ts
.github/workflows/systemtest.yml
```
