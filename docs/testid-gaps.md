

# `data-testid` gaps

> **Status: v1.1.0.** [Cosy-Frontend PR #118](https://github.com/Magenta-Mause/Cosy-Frontend/pull/118)
> shipped in this release, so its ids now exist in the deployed UI and the page objects
> use them. **Only Phase 1 of the request was implemented** — the Phase 2 ids were not,
> so those sites still use accessible role/label selectors marked `// TODO(testid)`.

**Delivered in v1.1.0 and now consumed by the suite:** `login-open-btn`,
`login-username-input`, `login-password-input`, `login-submit-btn`, `options-banner`,
`logout-btn`, `logout-confirm-btn`, `create-server-plot`, `server-house`,
`create-server-next-btn`, `create-field-{server_name,docker_image_name,docker_image_tag,execution_command,docker_max_memory}`,
`create-confirm-btn`, `create-success-open-dashboard-btn`, `server-tab-{overview,console,metrics,file_explorer,settings}`,
`server-start-stop-btn`, `server-status-indicator`, `server-delete-btn`,
`delete-confirm-input`, `delete-confirm-btn`, `console-log-list`,
`console-command-input`, `console-send-btn`, `files-new-folder-btn`, `file-row`,
`file-row-menu-btn`, `mkdir-name-input`, `mkdir-submit-btn`, `rename-name-input`,
`rename-submit-btn`, `delete-submit-btn`.

**Three landed under different names than requested** — the tables below still show the
original proposals:

| Requested | Shipped as | Consequence for the page object |
|---|---|---|
| `server-house-{uuid}` | `server-house` (static) | must still be narrowed by the house's aria-label |
| `file-row-name` | `file-row` (whole row, static) | narrowed with `has:` an exact-text child, not `hasText:` (substring) |
| `file-row-rename-btn` / `file-row-delete-btn` | `file-row-menu-btn` | the inline per-action buttons no longer exist; open the dropdown, then pick a `role=menuitem` |

**Still missing — this is the live backlog.** All of Phase 2 (users/invites, settings,
metrics, access groups, public dashboard), plus `create-volume-mount-input`,
`memory-unit-select`, `game-option-{slug}`, `template-option-{…}`, `files-upload-btn`,
`files-download-dir-btn`, and testids on the row dropdown's menu items.

**New surface with no ids and no coverage yet** (added in v1.1.0): the file editor
(`editfile-textarea` / `editfile-save-btn` DO exist), Change Permissions, Upload Archive
and Download Directory. A file-edit spec is now feasible and would be worth adding.

Paths are relative to the `Cosy-Frontend` repo. "Current selector" is what the page
object uses today.

## Auth / chrome

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `login-open-btn` | `src/components/display/Login/LoginBanner/LoginBanner.tsx` | `getByRole('button', { name: 'Sign In' }).first()` |
| `login-username-input` | `src/components/display/Login/LoginDialog/LoginForm.tsx` | `dialog.getByLabel('Username')` |
| `login-password-input` | `src/components/display/Login/LoginDialog/LoginForm.tsx` | `dialog.getByLabel('Password')` |
| `login-submit-btn` | `src/components/display/Login/LoginDisplay/LoginDisplay.tsx` | `dialog.getByRole('button', { name: /Sign In\|Loading/ })` |
| `options-banner` | `src/components/display/Configurations/OptionsBannerDropdown/OptionsBannerDropdown.tsx` | `locator('#banner')` (existing id, not a testid) |
| `logout-btn` | `src/components/display/Configurations/OptionsBannerDropdown/LogOutButton/LogOutButton.tsx` | `getByRole('button', { name: 'Log Out' })` (aria-label) |
| `logout-confirm-btn` | `src/components/display/Configurations/OptionsBannerDropdown/LogOutButton/LogOutAlertDialog.tsx` | `dialog.getByRole('button', { name: 'Log Out' })` |

## Home / server list

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `create-server-plot` | `src/components/display/GameServer/ConstructionPlace/ConstructionPlaceHouse.tsx` | `getByRole('link', { name: 'Create a new Game Server Configuration' })` |
| `server-house` (static; filter by content — was proposed as `server-house-{uuid}`) | `src/components/display/GameServer/GameServerHouseAligner/…` (server house link) | `getByRole('link', { name: /Game Server Configuration: {name}/ })` — the suite prefers URL navigation (`/server/{uuid}`) instead |

## Create-server wizard (released revision 2659b07)

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `create-server-next-btn` | `src/components/display/GameServer/CreateGameServer/GameServerCreationButton.tsx` | `getByRole('button', { name: /Next Step\|Continue without Template\|Create Server/ })` (label changes per step) |
| `create-field-server_name` | `src/components/display/GameServer/CreateGameServer/GenericGameServerCreationInputField.tsx` | `locator('#server_name')` (existing id) |
| `create-field-docker_image_name` | same | `locator('#docker_image_name')` |
| `create-field-docker_image_tag` | same | `locator('#docker_image_tag')` |
| `create-field-docker_max_memory` | `src/components/display/GameServer/CreateGameServer/MemoryLimitInputFieldCreation.tsx` | `locator('#docker_max_memory')` |
| `create-volume-mount-input` | `src/components/display/GameServer/CreateGameServer/VolumeMountInput.tsx` | `getByPlaceholder('/data')` (the always-present first ListInput row) |
| `create-confirm-btn` | `src/components/display/GameServer/CreateGameServer/ConfirmCreateDialog.tsx` | `alertdialog.getByRole('button', { name: 'Create Server' })` |
| `create-success-open-dashboard-btn` | `src/components/display/GameServer/CreateGameServer/SuccessDialog.tsx` | `getByRole('button', { name: 'Go to dashboard' })` |

## Server detail / lifecycle

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `server-start-stop-btn` | `src/components/display/GameServer/GameServerStartStopButton/GameServerStartStopButton.tsx` | `getByRole('button', { name: 'Start' \| 'Shutdown' })` |
| `server-status-indicator` | `src/components/display/GameServer/GameServerStatusIndicator/GameServerStatusIndicator.tsx` | `getByText('Running' \| 'Stopped' \| …)` |
| `server-tab-{key}` — keys are the internal tab keys (`overview`, `console`, `metrics`, `file_explorer`, `settings`), NOT the route names | `src/components/display/GameServer/GameServerDetailPageLayout/FancyNavigationButton.tsx` (used from `GameServerDetailPageLayout.tsx`) | none — tab labels are visually hidden until hover, so the suite navigates by URL (`/server/{uuid}/console`, `/files`, `/settings/general`) |
| `server-delete-btn` | `src/components/display/GameServer/EditGameServer/UncosyZone.tsx` | `getByRole('button', { name: 'Delete' })` |
| `delete-confirm-input` | `src/components/display/GameServer/DeleteGameServerAlertDialog/DeleteGameServerAlertDialog.tsx` | `dialog.locator('#serverName')` (existing id) |
| `delete-confirm-btn` | same | `dialog.getByRole('button', { name: 'Delete' })` |

## Console

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `console-log-list` | `src/components/display/LogDisplay/LogDisplay.tsx` | `locator('[data-testid="virtuoso-item-list"]')` (react-virtuoso's own test id) |
| `console-command-input` | `src/components/display/LogDisplay/LogDisplay.tsx` | `getByPlaceholder('Enter command...')` |
| `console-send-btn` | `src/components/display/LogDisplay/LogDisplay.tsx` | not selected directly — commands are submitted via Enter |

## Files (released revision 2659b07)

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `files-new-folder-btn` | `src/components/display/GameServer/FileBrowser/FileBrowserHeader/FileBrowserHeader.tsx` | `getByRole('button', { name: 'New Directory' })` |
| `file-row-name` | `src/components/display/GameServer/FileBrowser/FileBrowserRow/FileBrowserRow.tsx` | `getByText(name, { exact: true })` (the filename cell) |
| `file-row-rename-btn` / `file-row-delete-btn` | same | `getByRole('button', { name: \`Rename ${name}\` })` / `getByRole('button', { name: \`Delete ${name}\` })` (inline row actions, aria-labelled) |
| `mkdir-name-input` / `mkdir-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/MkdirDialog.tsx` | `dialog.getByRole('textbox')` / `getByRole('button', { name: 'Create' })` |
| `rename-name-input` / `rename-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/RenameDialog.tsx` | `dialog.getByRole('textbox')` / `getByRole('button', { name: 'Rename' })` |
| `delete-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/DeleteDialog.tsx` | `dialog.getByRole('button', { name: 'Delete' })` |
| `files-upload-btn` / `files-download-dir-btn` | `src/components/display/GameServer/FileBrowser/FileBrowserDialog/FileBrowserDialog.tsx` | `getByRole('button', { name: 'Upload' })` / `getByRole('button', { name: 'Download Directory' })` (not currently driven by a spec) |

## Phase 2 — extended feature selectors (release channel: role/label/text/id only)

Icon-only controls with **no accessible name** are located structurally today
(marked `// TODO(testid)` in the page objects) — each needs a `data-testid`:

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `invite-user-btn` | `.../UserInvite/UserInviteButton.tsx` | `getByRole('button', { name: 'Users' })` (its aria-label, not the visible "Invite User") |
| `invite-username-input` / `invite-role-select` / `invite-generate-btn` | `.../UserInvite/InviteForm/InviteForm.tsx` | `#invite-username` / `#invite-role` / `getByRole('button', { name: 'Generate Invite' })` |
| `invite-link` | `.../UserInvite/InviteForm/InviteResult.tsx` | `getByText(/inviteToken=/)` (select-all div) |
| `user-row-menu-btn` | `.../UserDetailPage/UserRow.tsx` | **icon-only, no name** → `[data-slot="card"]` (filter by username) → `[data-slot="button"]` |
| `settings-confirm-btn` | `.../GameServerSettings/SettingsActionButtons.tsx` | `getByRole('button', { name: 'Confirm' })` |
| `settings-server-name-input` | `.../EditGameServer/InputFieldEditGameServer.tsx` | `getByPlaceholder('My Game Server')` (**not label-associated** — no id) |
| `design-tile-{house,castle}` | `.../DesignSettingsSection/DesignSettingsSection.tsx` | `getByRole('button', { name: 'House'\|'Castle' })`; **selection has no aria** → asserted via the `bg-button-primary-default/30` class |
| `rcon-{enable-toggle,port-input,password-input}` | `.../RconSettingsSection/RconSettings.tsx` | `getByRole('button', { name: 'Enable RCON' })` / placeholders `25575` / `mysecretpassword` |
| `webhook-{create-btn,url-input}` + event toggles | `.../WebhooksSettingsSection/*` | `getByRole('button', { name: 'Create Webhook' })`, `#webhook-url`, `getByRole('button', { name: 'Server Stopped' })` (webhook edit/delete are icon-only, **no name**) |
| `access-group-*`, member remove btn | `.../AccessManagement/*` | group-name/add-user via placeholders `Enter group name` / `Enter username`; permissions via `getByRole('button', { name: 'See Server' })`; remove-member is icon-only, **no name** |
| `metric-card-{type}` | `.../MetricDisplay/MetricGraph.tsx` | `getByText('CPU'\|'Memory')` (CardTitle is a div); chart SVG asserted via `.recharts-surface path` |
| `public-dashboard-visible-toggle`, widget delete btn | `.../GenericLayoutBuilder/GenericLayoutBuilder.tsx` | `getByRole('button', { name: 'Make Public Dashboard Visible' })`; layout-builder delete-widget is icon-only, **no name** |
| `game-option-{slug}`, `template-option-{id}` | `.../CreateGameServer/GenericGameServerCreationInputField.tsx`, `.../CreationSteps/Step2/*` | released step 1 selects a game via the `#external_game_id` AutoComplete (`getByRole('option', { name })`, generic fallback = "Generic Game"); step-2 template cards = `role=option` in a `role=listbox` |
| console `send-btn` | `.../LogDisplay/LogDisplay.tsx` | icon-only, **no name** → commands submitted via Enter |

## Feature notes (released version — not just selectors)

- **File writes require a declared volume mount.** In the released browser
  (`FileBrowserDialog` / `FileBrowserList`), New Directory / rename / delete / upload
  are all gated on a *non-synthetic* path — i.e. one inside a server's declared
  `volume_mounts`. On a server without a volume the browser is a read-only, empty
  "No files" view. The `files` spec therefore provisions a server WITH a `/data`
  volume through the wizard and operates inside it. A `data-testid` won't change this;
  it is the release's feature model.
- **No file-edit affordance.** The released file browser has no in-place file editor
  (no `EditFileModal`), so file create/edit is out of scope for the `files` spec. If a
  future release adds one, extend the spec + this table then.
- **No forced first-login password-change flow.** `UserInviteService` builds the
  redeemed user with `defaultPasswordReset(true)`, but the flag's getter has **zero
  usages** and no change-password step is surfaced anywhere in the frontend — it is a
  dormant no-op. The `invites` spec proves the reachable path (redeem → normal login);
  if forced rotation is intended, both backend enforcement and a UI dialog are missing.
- **No dedicated public-dashboard route.** The public dashboard is `/server/{uuid}/
  ?view=public` (reachable unauthenticated), not a `/public/...` route. Fine for the
  test; noted so nobody hunts for a route that doesn't exist.
- **Public-dashboard layout builder is drag-and-drop** with icon-only, id-less
  controls, so the `public-dashboard` spec configures the layout over the API and
  proves the unauthenticated *view* renders. Add ids to `GenericLayoutBuilder` to make
  the editor itself UI-testable.
- **Template cards carry no artwork** (text-only); artwork lives only on the game
  entries, so `games-search` asserts artwork on the game option, not the template.
