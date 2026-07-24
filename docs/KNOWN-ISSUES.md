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
