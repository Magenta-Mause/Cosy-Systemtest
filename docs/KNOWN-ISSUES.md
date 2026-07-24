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

### Minecraft template/fixture uses PaperMC, not Vanilla (CI world-gen budget)

The heavyweight Minecraft paths (`server-from-template` UI spec + the API
`minecraftServer` fixture used by `rcon`) run **PaperMC** (`TYPE=PAPER`), not Vanilla.
On a 4-vCPU GitHub runner, vanilla world generation routinely overran the 10-minute
ready budget (the first full run spent ~30 min on this spec across retries and still
never reached RUNNING). Paper is a drop-in, vanilla-compatible server that generates a
world far faster and supports the same RCON `list` command, so it boots reliably within
budget. `server-from-template` also runs with `retries: 0` — its failure modes are not
transient, so retrying only multiplies its ~10-minute cost.
