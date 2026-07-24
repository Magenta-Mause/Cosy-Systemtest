import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, FilesPage, HomePage } from '@pages/index';
import { TEST_SERVER_MEMORY_LIMIT, TOSIOS_IMAGE } from '@helpers/constants';

/**
 * Feature: files — real file operations through the released file browser: create
 * a directory, rename it, and delete it.
 *
 * Release constraint (frontend 5dba6e8): the file browser only exposes files that
 * live inside a server's declared *volume mounts*; a server without a volume has a
 * read-only, empty browser (no New Directory / rename / delete / upload). The shared
 * tosios server has no volume, so this spec provisions its OWN server WITH a `/data`
 * volume mount through the UI wizard, then operates inside that volume. (The released
 * browser also has no file-edit affordance, so file create/edit is not covered — see
 * docs/testid-gaps.md.)
 */
test.describe('@core files', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 360_000 });

  test('create, rename and delete a directory inside a volume mount', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const home = new HomePage(page);
    const create = new CreateServerPage(page);
    const files = new FilesPage(page);

    const serverName = `systemtest-files-${Date.now()}`;
    const dirName = `systemtest-dir-${Date.now()}`;
    const renamedDir = `${dirName}-renamed`;
    let uuid = '';

    try {
      uuid = await test.step('Given: a running tosios server with a /data volume, created via the UI', async () => {
        await home.navigate();
        await home.openCreateServerModal();
        await create.createWithCustomImage({
          serverName,
          dockerImage: TOSIOS_IMAGE,
          imageTag: 'latest',
          memoryLimit: TEST_SERVER_MEMORY_LIMIT,
          volumeMount: '/data',
        });
        await create.openCreatedServer();
        await page.waitForURL(/\/server\/[^/]+/);
        const id = page.url().match(/\/server\/([^/?#]+)/)?.[1];
        expect(id, 'server uuid in URL').toBeTruthy();

        // Start it so the managed volume is materialised on disk before file ops.
        await apiClient.ensureRunning(id!);
        return id!;
      });

      await test.step('Given: the /data volume open in the file browser', async () => {
        await files.goto(uuid, 'data');
      });

      await test.step('When: creating a directory, Then: it appears', async () => {
        await files.makeDirectory(dirName);
        await files.expectEntryVisible(dirName);
      });

      await test.step('When: renaming the directory, Then: the new name appears', async () => {
        await files.rename(dirName, renamedDir);
        await files.expectEntryVisible(renamedDir);
      });

      await test.step('When: deleting the directory, Then: it is gone', async () => {
        await files.deleteEntry(renamedDir);
        await files.expectEntryAbsent(renamedDir);
      });
    } finally {
      // Keep the runner tidy even though the VM is thrown away after the run.
      const created =
        uuid || (await apiClient.listServers()).find((s) => s.server_name === serverName)?.uuid;
      if (created) await apiClient.deleteServer(created).catch(() => {});
    }
  });
});
