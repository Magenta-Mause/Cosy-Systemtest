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
| `server-house-{uuid}` | `src/components/display/GameServer/GameServerHouseAligner/…` (server house link) | `getByRole('link', { name: /Game Server Configuration: {name}/ })` — the suite prefers URL navigation (`/server/{uuid}`) instead |

## Create-server wizard

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `create-server-next-btn` | `src/components/display/GameServer/CreateGameServer/GameServerCreationButton.tsx` | `getByRole('button', { name: /Continue without Template\|Create Server/ })` |
| `create-field-server_name` | `src/components/display/GameServer/CreateGameServer/GenericGameServerCreationInputField.tsx` | `locator('#server_name')` (existing id) |
| `create-field-docker_image_name` | same | `locator('#docker_image_name')` |
| `create-field-docker_image_tag` | same | `locator('#docker_image_tag')` |
| `create-field-docker_max_memory` | `src/components/display/GameServer/CreateGameServer/MemoryLimitInputFieldCreation.tsx` | `locator('#docker_max_memory')` |
| `create-confirm-btn` | `src/components/display/GameServer/CreateGameServer/ConfirmCreateDialog.tsx` | `alertdialog.getByRole('button', { name: 'Create Server' })` |
| `create-success-open-dashboard-btn` | `src/components/display/GameServer/CreateGameServer/SuccessDialog.tsx` | `getByRole('button', { name: 'Open Dashboard' })` |

## Server detail / lifecycle

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `server-start-stop-btn` | `src/components/display/GameServer/GameServerStartStopButton/GameServerStartStopButton.tsx` | `getByRole('button', { name: 'Start' \| 'Shutdown' })` |
| `server-status-indicator` | `src/components/display/GameServer/GameServerStatusIndicator/GameServerStatusIndicator.tsx` | `getByText('Running' \| 'Stopped' \| …)` |
| `server-tab-{label}` | `src/components/display/GameServer/GameServerDetailPageLayout/FancyNavigationButton.tsx` (used from `GameServerDetailPageLayout.tsx`) | none — tab labels are visually hidden until hover, so the suite navigates by URL (`/server/{uuid}/console`, `/files`, `/settings/general`) |
| `server-delete-btn` | `src/components/display/GameServer/EditGameServer/UncosyZone.tsx` | `getByRole('button', { name: 'Delete' })` |
| `delete-confirm-input` | `src/components/display/GameServer/DeleteGameServerAlertDialog/DeleteGameServerAlertDialog.tsx` | `dialog.locator('#serverName')` (existing id) |
| `delete-confirm-btn` | same | `dialog.getByRole('button', { name: 'Delete' })` |

## Console

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `console-log-list` | `src/components/display/LogDisplay/LogDisplay.tsx` | `locator('[data-testid="virtuoso-item-list"]')` (react-virtuoso's own test id) |
| `console-command-input` | `src/components/display/LogDisplay/LogDisplay.tsx` | `getByPlaceholder('Enter command...')` |
| `console-send-btn` | `src/components/display/LogDisplay/LogDisplay.tsx` | not selected directly — commands are submitted via Enter |

## Files

| Suggested `data-testid` | Frontend file | Current selector |
|---|---|---|
| `files-new-folder-btn` | `src/components/display/GameServer/FileBrowser/FileBrowserHeader/FileBrowserHeader.tsx` | `getByRole('button', { name: 'New Directory' })` |
| `file-row-{name}` | `src/components/display/GameServer/FileBrowser/FileBrowserRow/FileBrowserRow.tsx` | `locator('div[role="button"]').filter({ hasText: name })` |
| `file-row-menu-btn` | same | `row.getByRole('button')` (the single ⋯ trigger in the row) |
| `mkdir-name-input` / `mkdir-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/MkdirDialog.tsx` | `dialog.getByRole('textbox')` / `getByRole('button', { name: 'Create' })` |
| `rename-name-input` / `rename-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/RenameDialog.tsx` | `dialog.getByRole('textbox')` / `getByRole('button', { name: 'Rename' })` |
| `delete-submit-btn` | `src/components/display/GameServer/FileBrowser/dialogs/DeleteDialog.tsx` | `dialog.getByRole('button', { name: 'Delete' })` |
| `editfile-textarea` / `editfile-save-btn` | `src/components/display/GameServer/FileBrowser/EditFileModal/EditFileModal.tsx` | `dialog.getByRole('textbox')` / `getByRole('button', { name: 'Save' })` |

## Feature gap (not just a selector)

- **No "new file" affordance in the file browser.** The browser can create
  *directories* (`New Directory`), edit / rename / delete existing entries, and
  upload archives, but there is no UI to create a single new empty/text file. The
  `files` spec therefore asserts directory CRUD unconditionally and only edits a
  text file *if one already exists* in the server volume. Consider adding a
  "New File" action to `FileBrowserHeader.tsx` so the create-and-edit path is
  fully UI-testable.
