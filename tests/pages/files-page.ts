import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The file browser, derived from the RELEASED frontend (revision 2659b07, the image
 * pinned by installer v1.1.0).
 *
 * Important release behaviour: the file browser only exposes files inside a
 * server's declared *volume mounts*. The synthetic root (`/`) and any path not
 * inside a volume are read-only — no New Directory / rename / delete / upload
 * there (`isSynthetic` gates them). So real file operations are only possible
 * INSIDE a volume mount; deep-link straight into one via `goto(uuid, 'data')`.
 *
 * Since v1.1.0 write actions ALSO require the CHANGE_SERVER_FILES permission
 * (`canWrite` in FileBrowserList); download needs only READ_SERVER_FILES. The admin
 * the suite logs in as has both.
 *
 * ROW ACTIONS MOVED IN v1.1.0. They used to be inline icon buttons with aria-labels
 * "Rename <name>" / "Delete <name>"; they are now items inside a per-row dropdown
 * opened by the row's "More actions" trigger (`file-row-menu-btn`). The old inline
 * buttons do not exist any more, so the old selectors did not merely go stale — they
 * stopped matching anything at all.
 *
 * v1.1.0 also added file editing (EditFileModal, testids `editfile-textarea` /
 * `editfile-save-btn`), Change Permissions, Upload Archive and Download Directory.
 * None of those are covered by a spec yet — see docs/testid-gaps.md.
 */
export class FilesPage {
  constructor(private readonly page: Page) {}

  /**
   * Navigate to the file browser, optionally deep-linking into a sub-path (e.g. a
   * volume mount `data` → currentPath `/data`, where write operations are enabled).
   */
  async goto(uuid: string, subPath = ''): Promise<void> {
    const suffix = subPath ? `/${subPath.replace(/^\/+/, '')}` : '';
    await this.page.goto(`/server/${uuid}/files${suffix}`);
  }

  private get newFolderButton(): Locator {
    // fileBrowserHeader.newFolder = "New Directory" (only rendered on a non-synthetic path).
    return this.page.getByTestId('files-new-folder-btn');
  }

  /**
   * The mkdir/rename dialog inputs are controlled React inputs (value + onChange);
   * their submit handlers validate the *committed* state, so a single fill() event
   * that doesn't commit leaves the name empty and the submit silently no-ops. Drive
   * them with real keystrokes and assert the value stuck (fail fast, not a hang).
   */
  private async typeInto(locator: Locator, value: string, what: string): Promise<void> {
    await locator.click();
    await locator.press('ControlOrMeta+a');
    await locator.press('Delete');
    // Human-cadence keystrokes (see create-server-page.ts) — realistic and safe.
    await locator.pressSequentially(value, { delay: 60 });
    await expect(
      locator,
      `${what}: value "${value}" did not persist in the controlled dialog input.`,
    ).toHaveValue(value, { timeout: UI_ACTION_TIMEOUT_MS });
  }

  /**
   * A file/directory row, identified by its name cell.
   *
   * `data-testid="file-row"` is STATIC (one per row, not per name), so it has to be
   * narrowed. `has:` an exact-text child rather than `hasText:` — the latter is a
   * substring match, so a row named "data" would also match "data-backup".
   */
  private entry(name: string): Locator {
    return this.page
      .getByTestId('file-row')
      .filter({ has: this.page.getByText(name, { exact: true }) });
  }

  async expectEntryVisible(name: string): Promise<void> {
    await expect(this.entry(name)).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async expectEntryAbsent(name: string): Promise<void> {
    await expect(this.entry(name)).toHaveCount(0, { timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Create a directory in the current folder (New Directory → dialog → Create). */
  async makeDirectory(name: string): Promise<void> {
    await this.newFolderButton.click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await this.typeInto(dialog.getByTestId('mkdir-name-input'), name, 'new folder name');
    await dialog.getByTestId('mkdir-submit-btn').click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async rename(name: string, newName: string): Promise<void> {
    await this.openRowMenu(name);
    await this.menuItem('Rename').click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await this.typeInto(dialog.getByTestId('rename-name-input'), newName, 'rename target name');
    await dialog.getByTestId('rename-submit-btn').click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async deleteEntry(name: string): Promise<void> {
    await this.openRowMenu(name);
    await this.menuItem('Delete').click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await dialog.getByTestId('delete-submit-btn').click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  /**
   * Open a row's "More actions" dropdown, which is where rename / delete / edit /
   * download / change-permissions live since v1.1.0. Write actions are only rendered
   * when the path is non-synthetic AND the user holds CHANGE_SERVER_FILES, so a
   * missing item means a permission or path problem, not a selector problem.
   */
  private async openRowMenu(name: string): Promise<void> {
    const row = this.entry(name);
    await expect(
      row,
      `file browser: no row named "${name}" to act on`,
    ).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await row.getByTestId('file-row-menu-btn').click();
  }

  /** An item in the currently-open row dropdown. */
  private menuItem(action: 'Rename' | 'Delete' | 'Edit' | 'Download' | 'Export'): Locator {
    // TODO(testid): add data-testid={`file-row-${action}`} to FileBrowserRow's menu items
    return this.page.getByRole('menuitem', { name: action, exact: true });
  }
}
