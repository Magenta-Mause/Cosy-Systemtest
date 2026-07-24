# Known issues & release behaviours (Cosy under test)

Notes for whoever triages a red run: behaviours of the **released** product
(frontend `5dba6e8`, installer v1.0.3) that shaped how the specs drive it, plus a
rare crash the suite guards against. These are not test bugs to "fix" here.

## create wizard — step 1 REQUIRES selecting a game (verified)

Filling only the server name does **not** enable "Next Step". Step 1 registers two
fields in the page-validity gate — `server_name` **and** `external_game_id` (the game
autocomplete) — and `GenericGameServerCreationPage` enables the advance button only
when *every* registered attribute is both touched **and** valid.

`AutoCompleteInputField/useAutoComplete.ts` sets
`setAttributeTouched('external_game_id', gameServerState['external_game_id'] !== undefined)`,
so until a game is **selected** the field is `touched=false` and the whole step stays
invalid → "Next Step" is disabled forever.

The wizard's intended escape hatch: Step 1 passes `alwaysIncludeFallback` +
`fallbackValue={GENERIC_GAME_PLACEHOLDER_VALUE}` + `defaultOpen`, so the game popover
opens on focus and **always** contains a generic **"Generic Game"** fallback item
(rendered client-side by `AutoCompleteItemList`, present even when the hosted games
API is down or returns nothing). Selecting it sets `external_game_id` to the generic
value → touched + valid (validator is `() => true`) → "Next Step" enables.

**How the suite handles it:** `create-server-page.ts` selects the generic fallback
after typing the name. It's chosen over a real game because it is offline-safe *and*
selects no template, so step 3's Docker image stays empty/editable — a clean path to
the custom `halftheopposite/tosios` image the spec creates.

**Verified locally** (released app dialog, mocked auth, games API returning `[]`):
Next Step is disabled after the name alone (`enabledAfterNameOnly=false`), the
"Generic Game" fallback appears and is selectable with the games API empty, and after
selecting it Next Step enables and advancing reaches step 2 — no crash.

## Typing into controlled wizard inputs — use human-cadence keystrokes

Every wizard field is a fully controlled React input (`value={gameServerState[attr]}`).
Playwright `fill()` (a single synthetic `input` event) does not reliably commit into
that controlled state; the page objects use `pressSequentially(value, { delay: 60 })`
(real per-keystroke events) and assert `toHaveValue` — verified locally to persist the
value at both machine and human speed.

## create wizard — the RAM limit is a compound number+unit widget

Step 3's "RAM Limit" (`MemoryLimitInput`) is **not** a single text input. It is a
numeric `<input type="number">` (id `docker_max_memory`, DOM value = just the number,
e.g. `"512"`) plus a separate unit `<Select>` (`"MiB"` | `"GiB"`, default `"MiB"`); it
emits `${number}${unit}` (e.g. `"512MiB"`) to the parent. Typing the whole string
`"512MiB"` into the number input is wrong — the letters are rejected and its value
stays `"512"`. The suite types only the numeric part and, for non-default units (GiB,
used by the Phase-2 Minecraft template), opens the unit select and picks the option.
Verified locally: typing `"512"` persists as `"512"` and Create Server enables
(the parent receives `"512MiB"`). Note the RAM/CPU fields are only *required* when the
user has a quota; the installer admin (OWNER) is unlimited, so they are optional.

## RARE: React #185 (blank page) during the create flow — heisenbug

One earlier CI run blanked to a white page with **React #185** ("maximum update depth
exceeded") while in the create flow; the trace also showed a **400 on
`GET /api/auth/token`**. It has **not** recurred and could **not** be reproduced
locally in any faithful configuration (isolated Step-1 dev + production builds; the
real app dialog with empty and with populated games/templates; machine- and
human-speed typing) — typing never triggered it. Treat it as a rare heisenbug, most
likely an **auth-token refresh flipping the session mid-flow**: a failed
`/api/auth/token` makes `AuthProvider` set `authorized=false`, unmounting the open
create dialog and its in-flight inputs — a plausible #185 trigger that merely
coincides with typing. The primary create-flow blockers in CI were actually the
`fill()` commit problem and the game-required gate above, both now handled.

**Guard kept:** `create-server-page.ts` listens for React #185 / "maximum update
depth" and, if the wizard blanks or that error fires during an interaction, fails
RED with a clear `Released create wizard CRASHED …` message rather than a misleading
timeout — so if the heisenbug reappears it is reported truthfully.

### Latent wizard state-churn smell (real, not the observed trigger)

`useGameServerCreation.setCurrentPageValid` → `setPageValid(prev => ({ ...prev, [page]: v }))`
allocates a **new object every call even when unchanged** (no bail-out); Step 1 passes
`validator={z.string().min(1)}` (**fresh object per render**); the field + autocomplete
effects `setAttribute*` unconditionally keyed on `creationState.gameServerState`. Today
this converges (the module-level `PAGES` element keeps Step 1 from re-rendering on
`isPageValid` churn). Worth hardening upstream: stabilise the validator (module
constant) and bail out of `setPageValid` / `setAttribute*` when the value is unchanged.

## Phase-2 findings from the first full 19-feature run (2026-07-24)

### `/user-entity/{uuid}/change-password` is the SELF endpoint (403 for admins)

`PATCH /user-entity/{uuid}/change-password` (`PasswordUpdateDto { old_password,
new_password }`) is the **self-service** password change — the admin bearer is not
authorised to change *another* user's password there and gets **403 FORBIDDEN**. The
admin-side endpoint is `PATCH /user-entity/{uuid}/change-password-by-admin`
(`PasswordUpdateByAdminDto { new_password }`, no old password).

The suite's `provisionUser` originally redeemed an invite with a temp password then
called the *self* endpoint to set the final one — hence the 403. Redeeming an invite
already sets the account password directly (`UserInviteService.useInvite` encodes the
supplied password), and the advertised "forced first-login change" never fires
(`defaultPasswordReset(true)` is a **dormant no-op** — the getter has zero usages and
no frontend surfaces it). So `provisionUser` now simply **redeems with the final
password** and the user logs in with it — no change-password call at all.

### Game search list surfaces no artwork (released 5dba6e8)

The `games-search` spec originally asserted an `<img>` artwork element on each game
option. The released create wizard renders game options via
`Step1.mapGamesDtoToAutoCompleteItems` → `AutoCompleteItemList`, which only sets
`label` (game name) + `additionalInformation` (template count) and **no `leftSlot`**,
so the option row contains no artwork element. The spec therefore asserts a matching
game *result* appears (proving the hosted game-service path resolves), not artwork.
Surfacing SteamGridDB artwork in the game picker would be a frontend enhancement.

### Public-dashboard layout: never send a client `uuid` (backend robustness finding)

`PATCH /game-server/{uuid}/layout/public-dashboard`
(`PublicDashboardUpdateDto { enabled, layouts }`) persists each `PublicDashboardLayout`,
whose id is a JPA `@GeneratedValue @Id`. The released frontend
(`PublicDashboardSettingsSection`) creates new widgets **without** a `uuid` and lets
the backend generate it. Sending a client-generated `uuid` (as the spec first did via
`crypto.randomUUID()`) makes Hibernate treat the layout as a *detached* entity on the
cascade save → the PATCH fails with **500 "An unexpected error occurred"**. Fix was on
the test side (omit `uuid`, matching the released payload). Backend robustness gap:
this should be rejected as a 400 (or the id ignored) rather than surfacing a 500 — the
create path (`DefaultSettingsMapper`) already initialises `public_dashboard.layouts`
to an empty list, so an **empty** `layouts` array is handled fine; only a
client-supplied layout id triggers the crash.

### `start()` is rejected unless the server `isStopped()` — and image pulls contend (run 11)

`GameServerService.startServer` throws **409 "Server is not in a stopped state"**
unless the status `isStopped()` (`STOPPED || FAILED`). A start goes
`STOPPED → AWAITING_UPDATE → (PULLING_IMAGE) → RUNNING`, all async. Because the
shared tosios server is looked up **by name**, it is effectively shared across
parallel workers, so one worker can call `start()` while another worker's start
still has it in `AWAITING_UPDATE` → 409; and the RUNNING-wait can outlast a cold
pull. This surfaced in run 11: once both PaperMC servers actually booted (they were
broken in run 10, creating no real load), **two large image pulls ran concurrently**
with the tosios specs on a 4-vCPU runner, stalling tosios starts in `AWAITING_UPDATE`
past the old 120 s budget → `server-create` / `server-lifecycle` / `rcon` / `webhooks`
/ `logs-history` all regressed (409s and RUNNING-timeouts).

Fixed centrally, not per-spec:
- `ApiClient.waitUntilStartable` waits for the server to reach a startable state
  (STOPPED/FAILED, or RUNNING if someone else already brought it up), tolerating the
  transient AWAITING_UPDATE/PULLING_IMAGE/STOPPING states.
- `ApiClient.ensureRunning` waits-until-startable, starts (swallowing a 409 from a
  worker that raced us on the shared-by-name server), then waits for RUNNING on the
  generous `SERVER_COLD_START_TIMEOUT_MS` (300 s) budget. All the specs/fixtures that
  needed a running server now call it; `server-create`'s UI "reaches RUNNING" wait
  reuses the same budget and tolerates AWAITING_UPDATE.
- CI parallelism is capped at **2 workers** (`playwright.config.ts`) so pulls/boots
  don't stack. The two Minecraft specs are NOT otherwise serialised: they pull the
  same `itzg/minecraft-server` image, so the second reuses cached layers — the real
  lever is overall pull concurrency.

### Create wizard step 2 needs REQUIRED template variables filled to advance

Selecting a template makes the step-2 advance button read **"Apply Template"** and
gates it on `validateTemplateVariables(selectedTemplate, templateVariables)` — every
template variable must be non-empty + type/regex-valid. The hosted **PaperMC**
template's `version` variable has **no default**, so it starts empty and the button
stays disabled until it is filled. The variable inputs (`#version`, `#memory`, …)
mount a render tick AFTER the template card is clicked, so the page object's
`typeIfPresent` now **waits** for the input before deciding the template lacks it —
an instantaneous `isVisible()` check raced the render and skipped the required
`version`, leaving step 2 un-advanceable.

### `/users` renders the user table twice (mobile + desktop) — scope to the visible card

The `/users` route renders `UserTable` in both a mobile (`lg:hidden`) and a desktop
(`hidden lg:block`) layout, so every user's `[data-slot="card"]` exists **twice** in
the DOM. A bare `hasText` filter matches 2 elements and trips Playwright strict mode;
`UsersPage.userCard` now adds `.filter({ visible: true })` to restrict to the active
layout's card.

### Minecraft template/fixture uses PaperMC, not Vanilla (CI world-gen budget)

The heavyweight Minecraft paths (`server-from-template` UI spec + the API
`minecraftServer` fixture used by `rcon`) run **PaperMC** (`TYPE=PAPER`), not Vanilla.
On a 4-vCPU GitHub runner, vanilla world generation routinely overran the 10-minute
ready budget (the first full run spent ~30 min on this spec across retries and still
never reached RUNNING). Paper is a drop-in, vanilla-compatible server that generates a
world far faster and supports the same RCON `list` command, so it boots reliably within
budget. `server-from-template` also runs with `retries: 0` — its failure modes are not
transient, so retrying only multiplies its ~10-minute cost.

## Phase-2 findings from run 12/13

### Wizard catalog templates are gated by the SteamGridDB games API (product limitation)

The create wizard's step-1 game autocomplete searches the **games API**
(`cosy-game-api.jannekeipert.de`, a SteamGridDB proxy), which is DISJOINT from the
**template service** catalog. A catalog template whose `game_id` has no games-API
(SteamGridDB) presence is therefore **unreachable in the wizard** — you cannot select
its game, so you never reach its templates. This is why `server-from-template` cannot
use the TOSIOS catalog template (tosios has no SteamGridDB entry) and stays on a real
games-API-backed game (Minecraft). Worth surfacing in-product: templates for games
that lack an `external_game_id` should still be selectable (e.g. a "Custom / other"
game path in step 1).

### rcon Minecraft fixture: JVM heap == container limit → OOM (not a ready-pattern bug)

Investigating rcon's repeated fixture timeout (server never RUNNING+ready): the ready
regex `/Done \(|RCON running/i` **correctly matches** PaperMC's `Done (X.Xs)! For
help, type "help"`, so ready-detection was never the problem — the server was not
reaching a stable **RUNNING**. Root cause: the itzg `MEMORY` env was `2G` (JVM
-Xmx2G) while the Docker container limit was `2GiB` — heap equal to the whole
container leaves no room for JVM overhead (metaspace, stacks, direct buffers, GC), so
the container OOM-kills before/around world-gen, flapping and never stabilising.
Fixed by dropping the JVM heap to `1G` (MINECRAFT_JVM_MEMORY) under the 2 GiB limit.
The fixture's ready wait is also **bounded to 7 min** (MINECRAFT_READY_TIMEOUT_MS) so,
if the boot is still stuck next run (e.g. an image-pull stall keeping it in
AWAITING_UPDATE), `ensureRunning` fails cleanly with the last status instead of
burning the whole test timeout — at which point the honest call is to skip rcon on
GitHub-hosted runners with a documented note ("Minecraft does not reliably boot within
budget on the 4-vCPU runner; RCON is exercised locally / needs a lighter RCON-capable
image").

## rcon is QUARANTINED on CI (Minecraft never boots on a GitHub-hosted runner)

`rcon` is gated behind **`SYSTEMTEST_HEAVY`** (`runsOnlyWithHeavyEnabled()`), so the
nightly reports it as **SKIPPED** rather than as a ~20-minute red. It remains fully
runnable — set `SYSTEMTEST_HEAVY=1` locally or on a larger runner.

**Why.** Across runs 12-15 the `minecraftServer` fixture never got Minecraft
(itzg, `TYPE=PAPER`) to a stable **RUNNING** on a GitHub-hosted 4-vCPU / 16 GB runner
within the 7-minute ready budget. What was tried, in order:

1. **Ready-pattern audit** — `/Done \(|RCON running/i` *does* match PaperMC's
   `Done (X.Xs)! For help, type "help"`, so ready-detection was never the bug; the
   server genuinely never reached stable RUNNING.
2. **OOM fix** — the JVM heap equalled the container limit (`MEMORY=2G` inside a
   2 GiB container), leaving no room for JVM overhead; heap dropped to `1G`.
3. **Timeout mechanics** — worker-fixture setup is bounded by the GLOBAL timeout, not
   `describe.configure`; global raised to 600 s (run 14 died at the 30 s default).
4. **Serial execution** — `workers: 1` on CI, so no competing image pull at all.

None of it produced a boot. Each attempt costs ~20 min (1254 s in run 15).

**Consequence: RCON is UNVERIFIED in CI.** The feature is exercised only when the flag
is set.

**Follow-ups.** (a) Read the new `results/diagnostics/` artifact from the next run for
OOM-killer / disk-pressure evidence (`dmesg-oom.txt`, `df.txt`, `docker-stats.txt`) to
confirm whether this is resource exhaustion rather than a product bug. (b) If it is
environmental, move RCON coverage to a **lighter RCON-capable image** so the round-trip
is testable on a standard runner, rather than keeping a Minecraft-sized dependency.
