# Known issues & release behaviours (Cosy under test)

Notes for whoever triages a red run: behaviours of the **released** product
(frontend `5dba6e8`, installer v1.0.3) that shaped how the specs drive it, plus a
rare crash the suite guards against. These are not test bugs to "fix" here.

## Expected state of the dashboard (as of 2026-07-25)

The **"Cosy Systemtest"** SigNoz dashboard is *supposed* to show two reds and one skip.
Of 20 features: **17 pass, 2 fail, 1 is skipped.**

| Feature | State | Why | Fixed by |
|---|---|---|---|
| `templates` | RED | [Catalog template selection is broken in released v1.0.3](#confirmed-product-bug--catalog-template-selection-is-broken-in-released-v103) — string vs numeric `game_id` | already on frontend `main`, awaiting a release |
| `server-from-template` | RED | same bug — the wizard never lists a template to build from | same |
| `rcon` | SKIP | [Quarantined behind `SYSTEMTEST_HEAVY`](#rcon-is-quarantined-on-ci-minecraft-never-boots-on-a-github-hosted-runner) — Minecraft never boots within budget on a 4-vCPU GitHub runner | a lighter RCON-capable image, or a larger runner |

These are **not** suppressed or skipped to keep the dashboard green — they are detecting
genuine broken/unverified behaviour and will resolve on their own. What they *are*
excluded from is paging: `CosySystemtestFeatureFailing` skips the two reds and
`CosySystemtestFeatureNotRunning` skips `rcon`, because a rule that fires every night
forever gets muted and then misses the real thing. The dashboard's **"Unexpected
failures (release)"** tile applies the same exclusion and is the tile to react to;
**"Known product-bug reds (expected 2)"** and **"Intentional skips (expected 1: rcon)"**
show the excluded ones explicitly so the exclusions stay visible.

**When a release fixes the template bug** (the `CosySystemtestKnownBugFixed` alert mails
you when those two features go green for two consecutive runs): remove the
`feature!~"templates|server-from-template"` exclusion from the alert rule
(`cluster-deployment/infrastructure/signoz-alerts/rule-CosySystemtestFeatureFailing.json`)
and from the "Unexpected failures (release)" panel in
[signoz-dashboard.json](signoz-dashboard.json), update the table above, and delete the
`CosySystemtestKnownBugFixed` rule.

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

## CONFIRMED PRODUCT BUG — catalog template selection is broken in released v1.0.3

**No user can select any template in the create wizard.** Step 2 always renders
"No templates are available for this game.", for *every* game. `templates` and
`server-from-template` are therefore **correctly RED**: they are detecting a genuine
broken feature, not a test defect. **Do not weaken or skip them** — they will go green
on their own once a release ships the fix.

**The chain (each link verified):**

1. The hosted template service (v3) serves `game_id` as a **string slug** —
   e.g. `"minecraft"` (confirmed live against the hosted API).
2. The backend passes it through unchanged: `ExternalTemplateDto.java:18` declares
   `@JsonProperty("game_id") String gameId` — a **String**.
3. The games API (`cosy-game-api`, SteamGridDB proxy) is a *different* catalog and
   yields a **numeric** id; selecting a game in step 1 stores that number as
   `external_game_id` (e.g. `30203` for Minecraft).
4. Released frontend `CreationSteps/Step2.tsx:22-23` filters:
   `templates.filter((template) => template.game_id === creationState.gameServerState.external_game_id)`

`"minecraft" === 30203` is a strict comparison between a String and a Number, so it is
**always false** → `templatesForGame` is always empty → Step 2 short-circuits to its
"no templates" branch (which renders no listbox at all).

**Status: fixed on frontend `main`, unreleased.** The sentinel comment in `context.ts`
("Sentinel game_id (string, since template game_id is now a slug-or-numeric string)")
shows the type mismatch was addressed after 5dba6e8. This is a **released-only defect
awaiting the next release**.

**Why the suite reports it well:** `create-server-page.ts`'s `waitForTemplateOptions()`
polls generously and, on failure, reports that the wizard itself said no templates are
available for the game — explicitly distinguishing a real empty catalog from a wrong
selector, so the red row names the product bug rather than implicating the test.

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

## CONFIRMED PRODUCT BUG — the backend loses its Docker event stream and never recovers

**Symptom.** Partway through a run, *every* game-server operation stops completing.
Servers sit in **`AWAITING_UPDATE`** forever after a start, and in **`STOPPING`**
forever after a stop, while their containers are demonstrably fine. Specs report
`Server <uuid> did not reach RUNNING within 300000ms (last status: AWAITING_UPDATE)`
or `did not become startable within 300000ms (last status: STOPPING)`. Once it
happens, **nothing short of a backend restart recovers** — so every later
server-touching spec is red too, and the suite looks like it "regressed" when nothing
in the tests changed.

**It is not the test suite, and it is not resource contention.** Run 18
(`30131313148`) hit it with `rcon` SKIPPED (no Minecraft at all), `workers: 1`
(serial — exactly one server starting at a time) and the 50 MB tosios image already
local. The diagnostics rule out every environmental explanation:

- `free.txt`: **7.6 GB free RAM**, 13.5 GB available, swap untouched.
- `df.txt`: **85 GB free disk** (42 % used).
- `docker-stats.txt`: the game container at **0.02 % CPU, 46 MiB / 512 MiB**.
- `dmesg-oom.txt`: **empty** — no OOM kill.
- `docker-ps.txt`: `cosy-backend` **Up 59 minutes (healthy)**, never restarted.

**The decisive evidence.** At capture time the container
`cosy-3959d88f-61b6-4982-9f50-bfb6b4b6fae8` was **`Up About a minute`**, while the
nginx access log shows the suite polling that exact server **62 times over two solid
minutes** (23:32:06 → 23:34:07) — and every one of the 61 polls after the first
returned a **byte-identical 1836-byte response**. The container was running; the API
never once said so.

The mirror image appeared in `server-lifecycle`: the *same* uuid
`faf8d16f-2a53-4883-9032-0094a6f09531` was stuck in `STOPPING` across **two separate
300 s retries** — its container had already been stopped and removed.

**Root cause (read from the backend source).** `RUNNING` and `STOPPED` have exactly
one source: a single Docker `/events` subscription.

1. `DockerEventHandler.startEventListener()` opens `client.eventsCmd()…exec(callback)`
   **once**, from `@PostConstruct`.
2. Its `onError` **only logs** (`log.error("Error in Docker event listener", …)`).
   There is no reconnect, no backoff, no watchdog; `onComplete` is not handled at all.
3. `GameServerService.handleGameServerEngineEvent` is the **only** caller that sets
   `RUNNING` (on `start`) and `STOPPED` (on `die`).
4. The persisted status is reconciled against real container state **exactly once**,
   in `GameServerService.init()` — i.e. only at boot.

So the moment that one stream ends, the backend is permanently blind. It still
creates, starts, stops and removes containers correctly; it simply never learns that
any of it happened. Note the asymmetry that makes this so confusing: the *commands*
keep working, so `docker ps` looks healthy and nothing in the backend log looks
broken — only the status machine is frozen.

**CONFIRMED TRIGGER: a server DELETED while its container is still running.** Read
straight off the backend log of a run in which the wedge happened:

```
ERROR c.m.c.s.e.docker.DockerEventHandler : Error in Docker event listener
org.springframework.orm.ObjectOptimisticLockingFailureException:
  Unexpected row count (expected row count 1 but was 0) [update game_server_entity set ...]
  at … DockerEventHandler.handleDieEvent → notifyListeners
     → GameServerService.handleGameServerEngineEvent → handleGameServerEngineFailEvent
     → updateStatus → GameServerEntity
```

`GameServerService.deleteGameServerById` stops and removes the container **first** and
deletes the row **after**, so the container's `die` event races the row's disappearance.
The released `DockerEventHandler` handles that event on the docker-java callback thread
with no isolation at all, and both outcomes of the race are fatal:

- the row is already gone → `handleDieEvent` calls the server's status supplier
  (`getStatusFromEntity` → `getOrThrow`), which throws **404**; or
- the row is still there → the `die` is classified `FAILED` (the status is `RUNNING`, not
  `STOPPING`) and `updateStatus` writes to a row that vanishes before the flush →
  **`ObjectOptimisticLockingFailureException`** (the stack above).

Either exception escapes `notifyListeners` (a bare `forEach`, no try/catch), escapes
`onNext`, and **ends the subscription**; `onError` merely logs it. It fired exactly once
in run 18 — that was enough. It is intermittent because it depends on delete-versus-die
timing, which is why run 17 (same code, same image) stayed green end to end.

**The `responseTimeout` theory is DISPROVEN.** The earlier suspicion was that
`EngineConfiguration.dockerClient()`'s `.responseTimeout(Duration.ofSeconds(45))` — a
socket read timeout applied to the long-lived `/events` stream — tears the stream down
during a quiet window. A control experiment settled it: a spec that idled for 90 s (2× the
45 s timeout) with zero container activity and then required a stop to be observed
**PASSED against the OLD, buggy backend `sha-e200a4d`**. Silence does not kill the stream.
The idle spec was therefore worthless as a guard (green on buggy and fixed builds alike)
and has been replaced — see below. Not applying a `responseTimeout` to streaming commands
remains good hygiene, just not the cause of this bug.

**Suggested product fixes** (backend, not this repo):

1. **Isolate per-event handling**: an exception from handling ONE event must be caught and
   logged inside `onNext` instead of ending the stream, and vanished servers must be
   handled explicitly (no supplier / no row → nothing to update, not an exception).
2. Make the event subscription **self-healing**: reconnect with backoff in `onError` *and*
   `onComplete`, and re-reconcile statuses from real container state on each reconnect
   (`GameServerService.init()` already contains that reconciliation logic — it just never
   runs again).
3. Belt and braces: a periodic reconciliation sweep, so a missed event self-corrects
   instead of hanging a server forever. Also good hygiene: no `responseTimeout` on
   streaming commands (`eventsCmd`, `logsCmd`), or a separate `DockerHttpClient` for them.

**How the suite reports it now.** `helpers/docker.ts` probes the real container state
whenever a transitional status outlives `EVENT_STREAM_WEDGE_GRACE_MS` (45 s):

| waiting for | actual container   | verdict                              |
|-------------|--------------------|--------------------------------------|
| RUNNING     | running            | the `start` event was never received |
| STOPPED     | gone / not running | the `die` event was never received   |

On a match, `ApiClient.waitForStatus` / `waitUntilStartable` and
`ServerDetailPage.expectStatus` fail **immediately** with a message naming the
product bug, instead of burning 300 s three times over and reporting a generic
timeout. Ordinary timeouts now also append the real container state, and the
workflow extracts `docker-event-stream-errors.txt` from the (now complete) backend
log. If Docker is not queryable from the test process the diagnosis is skipped and
plain timeout behaviour applies.

**Regression guard: the `event-stream-resilience` spec.** Detection alone was not enough.
Every other spec touches the event stream only *incidentally*, back-to-back with other
container activity, so whether the stream dies depends on the accidental spacing of that
activity — run 17 was green and run 18 wedged four specs on the very same image. A run
against the fix (backend `sha-b8bec7c`) was likewise green **without ever exercising the
recovery path**, because the stream never died in it. A green run therefore proved
nothing.

`tests/specs/event-stream-resilience.spec.ts` (`@extended`, ~4 min) removes the luck by
performing the sequence that actually kills the stream:

1. **Control** — bring a throwaway tosios server to `RUNNING`. `AWAITING_UPDATE →
   RUNNING` has exactly one source, the Docker `start` event, so this *proves the stream
   was alive* going in (without it, a failure could not be told apart from "it was already
   dead"). The provocation servers are started next, still before any delete, so the whole
   setup demonstrably runs on a working stream.
2. **Provoke** — delete `DELETE_WHILE_RUNNING_PROVOCATIONS` (10) servers **while their
   containers are running**, all at once. Both the count and the concurrency are the
   mechanism, not decoration. A single delete usually WINS the race: handling one `die`
   costs a few DB round trips (`h`), while the delete still has a `docker ps` + `docker rm`
   to do before it commits (`D`), and `h < D` — which is exactly why the bug looked
   intermittent in the wild. But docker-java delivers events on ONE callback thread, so
   with N containers dying at once the k-th `die` is only *finished* at ~`k × h` while all
   N deletes commit at about the same `D`, in parallel; every victim with `k × h > D`
   therefore loses. Ten gives a comfortable margin over the ~5-15 that `D/h` plausibly is.
   The spec then waits `EVENT_STREAM_PROVOKE_SETTLE_MS` (5 s), because the DELETE calls
   return before the events they provoke have been handled.
3. **Detect** — stop the surviving control server through the UI and require `STOPPED`
   within `EVENT_STREAM_OBSERVE_TIMEOUT_MS` (90 s, not the generous 300 s). `RUNNING →
   STOPPING → STOPPED` needs no image pull and no container creation, so nothing
   legitimate is left to be slow about. The wedge probe above still fires first, at 45 s,
   telling "the container never stopped" apart from "the container stopped and the backend
   never heard" — the latter being the smoking gun, which the failure message states
   explicitly (it re-probes the control container) alongside the named mechanism
   ("a delete-while-running killed the Docker event subscription") and the container
   states of the deleted servers at the moment they were deleted.

**Expected verdicts.** Against the old backend `sha-e200a4d` this spec **must FAIL** —
that is the whole point, and the failure is the wedge diagnosis, not a timeout. Against a
build of `fix/docker-event-stream-resilience` (per-event exception isolation + vanished
servers handled + a self-healing subscription) it must **PASS**. The idle spec it replaced
passed on *both*, which is why it was deleted rather than kept alongside.

**Accepted side effect:** against a backend that still has the bug this spec *causes* the
wedge rather than stumbling into it, so specs running after it fail too — each in ~45 s
with the same named diagnosis. That is the honest reading of a broken build: the first
red row states the root cause instead of four later rows reporting mystery timeouts. It
runs every night rather than behind a flag because the bug class is severe (every server
frozen until a backend restart) and the ~4 min is cheap next to the ~46 min a single
undetected wedge cost in run 18. A single run can opt out with
`npx playwright test --grep-invert event-stream-resilience`.

**Why this matters for the budget.** In run 18 the wedge cost `300 s × 3 retries ×
4 specs` ≈ **46 minutes**, which pushed the job past its 60-minute
`timeout-minutes` — GitHub **cancelled** it at 23:34:05, mid-`webhooks`. The last two
"failures" in that run are teardown artifacts, not findings: `TypeError: fetch failed`
is the cancelled process, and `ERR_CONNECTION_REFUSED` is the `Uninstall Cosy` step
(23:34:09) tearing the stack down while Playwright was still winding down. With
fail-fast detection the same wedge costs ~45 s per attempt, so the suite finishes
inside its budget and still records a row per feature.
