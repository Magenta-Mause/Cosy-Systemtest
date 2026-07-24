import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The file browser (FileBrowser components). Directory rows are clickable to
 * descend; each row has a "⋯" actions menu (rename / edit / delete / download).
 * New folders come from the header "New Directory" button.
 *
 * Rows are matched by their visible name; the per-row menu trigger is the single
 * <button> inside the row. No Cosy-owned test ids exist yet — see
 * docs/testid-gaps.md. Note: the UI offers no "new file" affordance, so file
 * creation is not directly testable through the browser (recorded as a gap).
 */
export class FilesPage {
  constructor(private readonly page: Page) {}

  private get newFolderButton(): Locator {
    // fileBrowserHeader.newFolder = "New Directory"
    // TODO(testid): add data-testid="files-new-folder-btn" to FileBrowserHeader button
    return this.page.getByRole('button', { name: 'New Directory' });
  }

  /** A file/directory row by its name. The row itself has role="button". */
  row(name: string): Locator {
    // TODO(testid): add data-testid={`file-row-${name}`} to FileBrowserRow
    return this.page.locator('div[role="button"]').filter({ hasText: name }).first();
  }

  async expectEntryVisible(name: string): Promise<void> {
    await expect(this.row(name)).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async expectEntryAbsent(name: string): Promise<void> {
    await expect(this.row(name)).toHaveCount(0, { timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Create a directory in the current folder. */
  async makeDirectory(name: string): Promise<void> {
    await this.newFolderButton.click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await dialog.getByRole('textbox').fill(name);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Open the per-row "⋯" actions menu (the only button inside the row). */
  private async openRowMenu(name: string): Promise<void> {
    await this.row(name).getByRole('button').click();
  }

  async rename(name: string, newName: string): Promise<void> {
    await this.openRowMenu(name);
    // fileBrowserList.renameAction = "Rename"
    await this.page.getByRole('menuitem', { name: 'Rename' }).click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    const input = dialog.getByRole('textbox');
    await input.fill(newName);
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async deleteEntry(name: string): Promise<void> {
    await this.openRowMenu(name);
    // fileBrowserList.deleteAction = "Delete"
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Edit a text file's contents via the edit modal. */
  async editFile(name: string, content: string): Promise<void> {
    await this.openRowMenu(name);
    // fileBrowserList.editAction = "Edit"
    await this.page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    const textarea = dialog.getByRole('textbox');
    await textarea.fill(content);
    // editFileModal.save = "Save"
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Names of editable (text) files currently listed, if any. */
  async listEditableRowNames(): Promise<string[]> {
    // Best-effort: return visible row texts so a spec can pick an editable file.
    const rows = this.page.locator('div[role="button"]');
    return rows.allInnerTexts();
  }
}
