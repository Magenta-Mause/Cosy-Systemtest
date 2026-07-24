import { test, runsOnlyWithInstall } from '@fixtures/index';
import { FilesPage, ServerDetailPage } from '@pages/index';

/**
 * Feature: files — the file browser can create a directory, rename it, and delete
 * it, and edit a text file's contents.
 *
 * Note: the file browser exposes no "new file" affordance, so a file is not
 * created through the UI here; instead we edit an existing text file when one is
 * present (recorded as a gap in docs/testid-gaps.md). Directory CRUD is the always
 * available path and is asserted unconditionally.
 */
test.describe('@core files', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 120_000 });

  test('directory create/rename/delete and file edit in the browser', async ({
    loggedInPage: page,
    sharedServer,
  }) => {
    const detail = new ServerDetailPage(page, sharedServer.uuid);
    const files = new FilesPage(page);

    const dirName = `systemtest-dir-${Date.now()}`;
    const renamedDir = `${dirName}-renamed`;

    await test.step('Given: the file browser for the shared server', async () => {
      await detail.gotoFiles();
    });

    await test.step('When: creating a directory, Then: it appears', async () => {
      await files.makeDirectory(dirName);
      await files.expectEntryVisible(dirName);
    });

    await test.step('When: renaming the directory, Then: the new name appears', async () => {
      await files.rename(dirName, renamedDir);
      await files.expectEntryVisible(renamedDir);
    });

    await test.step('When: an editable text file exists, Then: editing it saves', async () => {
      // Best-effort and non-fatal: the file browser has no "new file" action, so
      // we can only edit a text file that already sits in the server volume. If
      // none is present we skip this sub-step without failing the directory CRUD
      // assertions (a genuine gap — see docs/testid-gaps.md).
      const rows = await files.listEditableRowNames();
      const editable = rows
        .map((r) => r.split('\n')[0]?.trim())
        .find((name) => !!name && /\.(txt|json|ya?ml|cfg|conf|properties|log|md)$/i.test(name));
      if (editable) {
        await files.editFile(editable, `# edited by systemtest ${new Date().toISOString()}\n`);
      } else {
        // eslint-disable-next-line no-console
        console.warn('files.spec: no editable text file in volume — file-edit sub-step skipped.');
      }
    });

    await test.step('When: deleting the directory, Then: it is gone', async () => {
      await files.deleteEntry(renamedDir);
      await files.expectEntryAbsent(renamedDir);
    });
  });
});
