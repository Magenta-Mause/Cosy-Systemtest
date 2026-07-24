# Known issues (released Cosy under test)

Issues in the **released** product that the systemtest surfaces. These are notes for
whoever triages a red run, not test bugs to "fix" in this repo.

## create wizard: React #185 / blank page during the create flow (v1.0.3, frontend 5dba6e8)

**Symptom (CI):** in some runs, while `server-create` (and `files`, which provisions
through the same wizard) types the server name, the app blanks to a white page with
**React error #185** ("Maximum update depth exceeded" — an infinite render loop).
`server-create` retry 2 also logged a **400 on `GET /api/auth/token`** ("Failed to
refresh token") in the same trace.

**How the suite reports it:** `create-server-page.ts` listens for React #185 /
"maximum update depth" on the page. If the wizard blanks or that error fires during
an interaction, the page object throws a clear, truthful error
(`Released create wizard CRASHED …`) so the feature shows **RED** with the real cause
instead of a misleading "value did not persist" or a silent timeout. We do **not**
mask it.

### Local reproduction attempts — could NOT reproduce a typing-caused crash

Reproduced the released code at `5dba6e8` (worktree, React Compiler enabled) and drove
it with Playwright, both no-delay and 60 ms/keystroke:

| Configuration | Typing | Result |
|---|---|---|
| Isolated real Step 1 field(s), **dev** build | fast + 60 ms | value persists, **no #185** |
| Isolated real Step 1 field(s), **production** build (React Compiler prod output) | fast + 60 ms | value persists, **no #185** |
| **Real app** create dialog (mocked auth, empty data) | fast | value persists, **no #185** |
| **Real app** create dialog (mocked auth, populated games/templates) | fast + 60 ms | value persists, **no #185** |

So typing into `server_name` — at machine OR human speed — does **not** deterministically
crash the wizard in a clean environment. This rules out both "typing always crashes it"
and "fast programmatic keystrokes flood a Step-1 loop".

### Most likely cause: an auth-state flip mid-flow, not the typing

The one CI-specific signal not present locally is the **`/api/auth/token` 400** during
the flow. When identity-token refresh fails, `AuthProvider` calls `updateAuthState(null)`
→ `authorized` becomes `false` → the entire authenticated subtree (including the open
create dialog and its in-flight controlled inputs) unmounts while `loadPublicGameServer`
runs. That teardown/re-render collision is a far more plausible trigger for #185 than the
keystrokes, which merely coincide in time. (Auth refresh itself works — `auth.spec`
exercises refresh-on-reload and passes — so this is likely a token-TTL / refresh-cookie
timing edge, possibly specific to the long-running create flow.)

### Latent secondary risk in the wizard (real, but not reproduced as the trigger)

The wizard also has a genuine latent render-loop structure that could tip into #185 under
enough render pressure:

- `useGameServerCreation.setCurrentPageValid` → `setPageValid(prev => ({ ...prev, [page]: v }))`
  creates a **new `isPageValid` object every call, even when the boolean is unchanged**
  (no bail-out).
- Step 1 passes `validator={z.string().min(1)}` — a **fresh object every render**.
- `GenericGameServerCreationInputField` and `useAutoComplete` both have effects that
  `setAttributeTouched/Valid` unconditionally (new objects) keyed on `creationState.gameServerState`.

Today this converges (the module-level `PAGES` element keeps Step 1 from re-rendering on
`isPageValid` churn, so the field's `validator` dependency doesn't change). It is a smell
worth fixing upstream — stabilise the validator (module constant), and make
`setPageValid` / `setAttribute*` bail out when the value is unchanged.

**Upstream fix suggestions (Cosy-Frontend):** stop the `/auth/token` refresh from tearing
down the create dialog (guard the flow, or don't unmount on a transient refresh failure);
independently, harden the wizard state churn above. Once fixed and released, the crash
detection here simply stops firing.
