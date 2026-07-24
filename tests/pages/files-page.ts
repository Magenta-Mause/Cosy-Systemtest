import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The file browser, derived from the RELEASED frontend (revision 5dba6e8).
 *
 * Important release behaviour: the file browser only exposes files inside a
 * server's declared *volume mounts*. The synthetic root (`/`) and any path not
 * inside a volume are read-only — no New Directory / rename / delete / upload
 * there (`isSynthetic` gates them). So real file operations are only possible
 * INSIDE a volume mount; deep-link straight into one via `goto(uuid, 'data')`.
 *
 * Row actions are inline buttons with aria-labels `Rename <name>` / `Delete <name>`;
 * the "New Directory" button opens the mkdir dialog. There is NO file-edit in this
 * release. No `data-testid`s exist — see docs/testid-gaps.md.
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
    // TODO(testid): add data-testid="files-new-folder-btn" to FileBrowserHeader button
    return this.page.getByRole('button', { name: 'New Directory' });
  }

  /** The visible name cell of a file/directory row. */
  private entry(name: string): Locator {
    // The filename renders in its own text node; the row's action buttons carry the
    // name only in aria-labels, so an exact text match hits just the name cell.
    // TODO(testid): add data-testid={`file-row-${name}`} to FileBrowserRow
    return this.page.getByText(name, { exact: true });
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
    await dialog.getByRole('textbox').fill(name);
    // MkdirDialog submit label is "Create" (createAction).
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async rename(name: string, newName: string): Promise<void> {
    // Inline row action button, aria-label "Rename <name>".
    await this.page.getByRole('button', { name: `Rename ${name}` }).click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await dialog.getByRole('textbox').fill(newName);
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async deleteEntry(name: string): Promise<void> {
    // Inline row action button, aria-label "Delete <name>".
    await this.page.getByRole('button', { name: `Delete ${name}` }).click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }
}
