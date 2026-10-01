# Test architecture

How the Cosy systemtests are built. For commands and hard conventions see
[../CLAUDE.md](../CLAUDE.md) and [../README.md](../README.md).

## The idea

On every new Cosy version (and nightly), install the platform from scratch on a
throwaway machine — exactly like a real user — drive each feature through the real
UI, and report a per-feature pass/fail matrix. Phase 1 covers the install → core
lifecycle → uninstall path on the **release** channel, with results published as a
GitHub artifact (reporting dry-run; OTLP/SigNoz is Phase 3).

## Why a runner VM, not in-cluster

The test's core value is the **fresh-machine install path**. GitHub-hosted
`ubuntu-latest` gives a clean VM per run (docker + compose + systemd + journald),
public-repo minutes are free, and there is no persistent state to clean up — the VM
is discarded, and the `uninstall` assertion replaces any cleanup apparatus. Running
in-cluster (DinD on the single node) would add risk and test nothing extra.

## Layers

```
tests/specs/      Test cases — Given/When/Then via test.step(), no selectors, no raw API in assertions
tests/pages/      Page objects — all selectors + UI actions live here
tests/fixtures/   Custom test/expect + skip guard (runsOnlyWithInstall) + shared fixtures
tests/helpers/    install-log parsing, the API client, and timeout/constant definitions
scripts/          run-systemtest.ts — runs the suite, parses JSON → results/summary.json
```

Rules that keep the layers clean:

- Specs import `test` / `expect` **only** from `@fixtures/index`, never from
  `@playwright/test`.
- Specs contain **no selectors** — those live in page objects. Page objects use
  `getByTestId` where ids exist (many do since v1.1.0); the remaining sites use
  accessible role/label selectors, each flagged `// TODO(testid)` and catalogued in
  [testid-gaps.md](testid-gaps.md).
- `COSY_BASE_URL` is read **only** in `helpers/constants.ts` (`resolveBaseURL()`).
- Every timeout is a named constant in `helpers/constants.ts` — generous by design.

## Page objects track the RELEASED frontend, not `main`

The release channel installs the frontend *image pinned by the installer*, not
`main` — currently **`sha-2659b07`** (installer v1.1.0). **Derive selectors from the
released revision**, e.g. `git show 2659b07:<path>` /
`git ls-tree -r 2659b07 --name-only` in `Cosy-frontend` — not from `HEAD`.

**The PR gates are the deliberate exception** ([pr-gate.md](pr-gate.md)): a frontend PR
installs an image built from that pull request, so its page objects are exercised
against unreleased UI. That is the point — it is how a selector break is caught before
it merges rather than at 02:30 the next morning. It does not change the rule here: this
repo's `main` must keep matching the RELEASED frontend, because that is what the nightly
installs. A page object may only move to a new selector once the frontend change
carrying it has shipped; until then the frontend PR carries the systemtest change on a
matching branch, which the gate resolves and runs together.

**When a new Cosy release ships, re-derive the affected page objects against the new
pinned revision.** The v1.0.3 → v1.1.0 bump is the worked example of why this is not
busywork: the create-server wizard's steps were reshuffled (game *and* template moved
onto step 1, the server name moved to step 2), the file browser's per-row actions moved
from inline buttons into a dropdown, and Button gained a loading state that REPLACES its
label. The first two broke selectors outright; the third breaks any locator that matches
a button by its label while a request is in flight. See docs/KNOWN-ISSUES.md.

v1.1.0 is also the release that shipped the `data-testid`s from Cosy-Frontend PR #118,
so the page objects now use `getByTestId` wherever an id exists. Only PR #118's Phase 1
was implemented — the Phase 2 ids (users/invites, settings, metrics, game and template
options) do not exist, so those sites keep role/label selectors and a `// TODO(testid)`
marker. `docs/testid-gaps.md` is the live list.

## The install/teardown flow (owned by the workflow, not Playwright)

The workflow — not a spec — installs and uninstalls Cosy:

```mermaid
sequenceDiagram
    participant WF as systemtest.yml
    participant SH as install_cosy.sh
    participant PW as Playwright suite
    participant RN as run-systemtest.ts

    WF->>SH: sudo bash install_cosy.sh docker --default --port 8080 --domain localhost | tee install.log
    WF->>WF: poll /api/actuator/health up to 10 min (ok vs degraded)
    WF->>WF: export INSTALL_LOG, INSTALL_DIR
    WF->>RN: npx tsx scripts/run-systemtest.ts
    RN->>PW: npx playwright test (json reporter)
    PW-->>RN: JSON report
    RN->>RN: parse → results/summary.json (feature × status × duration)
    WF->>WF: uninstall_cosy.sh docker -y + assert clean → append `uninstall` row
    WF->>WF: upload playwright-report + results (always), traces/videos (always — video:'on')
```

`uninstall` is asserted by the workflow (no leftover `cosy-*` containers, install
dir gone) and appended to `results/summary.json` as its own feature row — there is
**no `uninstall.spec.ts`**.

## Credential parsing flow

Admin credentials are taken from the path a real user copies — the installer's
printed summary — and cross-checked against the generated `.env`, so two failure
modes stay distinguishable:

```mermaid
flowchart TD
    A[install.log stdout] -->|parseCredentialsFromLog| B[username + password]
    C[$INSTALL_DIR/config/.env] -->|readCredentialsFromEnvFile| D[username + password]
    B --> E{equal?}
    D --> E
    E -->|no| F[distinct error: summary is lying]
    E -->|yes| G[adminCreds fixture, cached per worker]
    G --> H[UI login in auth spec proves the printed password actually works]
```

`helpers/install.ts` strips ANSI colour codes, anchors on the summary marker, and
fails with a message quoting nearby lines if the installer's summary format changes.

## Fixtures

`tests/fixtures/index.ts` exports:

- `adminCreds` (worker) — parsed + cross-checked credentials, cached once per worker.
- `apiClient` (worker) — a logged-in `ApiClient` for setup/assert helpers (create /
  read / delete / poll game servers). Never used to *drive* a feature.
- `sharedServer` (worker) — the reusable tosios server via get-or-create, so the
  console/files/lifecycle specs don't each pay a cold pull. Each worker keys it by a
  per-worker name to avoid cross-worker collisions; each spec file can still
  provision its own.
- `loggedInPage` (test) — a fresh context already logged into the UI.
- `runsOnlyWithInstall()` — skip guard with a single uniform reason, so specs stay
  locally *listable* (`playwright test --list`) without an installed stack.

## Suite selection

By **Playwright tags**, not npm-script file lists (the sibling repo's silent-skip
trap). Every spec is tagged either `@core` or `@extended`; `npm run test:core` runs
`--grep @core`. New specs get a tag rather than an entry in a hand-maintained file list.

`@core` is the install → lifecycle → uninstall path: `install`, `auth`, `console`,
`files`, `server-create`, `server-lifecycle` (6 spec files). `@extended` is the other 13.
The distinction is load-bearing beyond the npm scripts — the **PR gates run `@core`
only** ([pr-gate.md](pr-gate.md)), so moving a spec between tags changes what blocks a
merge. The nightly runs everything regardless of tag.
