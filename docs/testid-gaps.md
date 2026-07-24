

> **Status 2026-07-24:** all ids below were implemented in [Cosy-Frontend PR #118](https://github.com/Magenta-Mause/Cosy-Frontend/pull/118)
> (three renames noted inline). Page objects stay on role/label selectors until a release
> ships the ids; then switch to `getByTestId` and clear this list.
# `data-testid` gaps

The Cosy frontend currently ships **zero `data-testid` attributes** (verified:
`grep -r data-testid Cosy-Frontend/src` → 0 hits). Every selector in this suite
therefore falls back to accessible role / label / text selectors, each marked with
a `// TODO(testid)` comment in the page object. This file is the backlog of ids to
add in `Cosy-Frontend` — each becomes a small frontend PR, after which the matching
page object should switch to `getByTestId(...)`.

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

## Create-server wizard (released revision 5dba6e8)

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

## Files (released revision 5dba6e8)

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `files-new-folder-btn` | `src/components/display/GameServer/FileBrowser/FileBrowserHeader/FileBrowserHeader.tsx` | `getByRole('button', { name: 'New Directory' })` |
| `file-row-name` | `src/components/display/GameServer/FileBrowser/FileBrowserRow/FileBrowserRow.tsx` | `getByText(name, { exact: true })` (the filename cell) |
| `file-row-rename-btn` / `file-row-delete-btn` | same | `getByRole('button', { name: \`Rename ${name}\` })` / `getByRole('button', { name: \`Delete ${name}\` })` (inline row actions, aria-labelled) |
| `mkdir-name-input` / `mkdir-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/MkdirDialog.tsx` | `dialog.getByRole('textbox')` / `getByRole('button', { name: 'Create' })` |
| `rename-name-input` / `rename-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/RenameDialog.tsx` | `dialog.getByRole('textbox')` / `getByRole('button', { name: 'Rename' })` |
| `delete-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/DeleteDialog.tsx` | `dialog.getByRole('button', { name: 'Delete' })` |
| `files-upload-btn` / `files-download-dir-btn` | `src/components/display/GameServer/FileBrowser/FileBrowserDialog/FileBrowserDialog.tsx` | `getByRole('button', { name: 'Upload' })` / `getByRole('button', { name: 'Download Directory' })` (not currently driven by a spec) |

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
