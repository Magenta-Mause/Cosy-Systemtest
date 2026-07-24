import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage, ServerDetailPage } from '@pages/index';
import { TEST_SERVER_MEMORY_LIMIT, TOSIOS_IMAGE } from '@helpers/constants';

/**
 * Feature: server-create — create a server with a custom image through the UI
 * creation wizard and get it to RUNNING.
 *
 * In the released frontend (5dba6e8) a freshly created server is STOPPED ("ready
 * to be started"), so after the wizard we start it through the UI and assert the
 * live status reaches RUNNING — the full "user creates and runs a server" path.
 */
test.describe('@core server-create', () => {
  runsOnlyWithInstall();

  // A cold Docker pull + start on a fresh runner needs a wide budget.
  test.describe.configure({ timeout: 180_000 });

  test('create a tosios server through the UI reaches RUNNING', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const home = new HomePage(page);
    const create = new CreateServerPage(page);
    const serverName = `systemtest-create-${Date.now()}`;
    let uuid = '';

    try {
      await test.step('Given: the create-server wizard is open', async () => {
        await home.navigate();
        await home.openCreateServerModal();
      });

      await test.step('When: creating a server with a custom image and 512 MiB', async () => {
        await create.createWithCustomImage({
          serverName,
          dockerImage: TOSIOS_IMAGE,
          imageTag: 'latest',
          memoryLimit: TEST_SERVER_MEMORY_LIMIT,
        });
        await create.openCreatedServer();
      });

      uuid = await test.step('Then: the app opens the new server detail page', async () => {
        await page.waitForURL(/\/server\/[^/]+/);
        const id = page.url().match(/\/server\/([^/?#]+)/)?.[1];
        expect(id, 'server uuid in URL').toBeTruthy();
        return id!;
      });

      await test.step('When: starting it via the UI, Then: it reaches RUNNING', async () => {
        const detail = new ServerDetailPage(page, uuid);
        // Created servers start out STOPPED in this release; start unless the
        // backend already brought it up.
        if ((await apiClient.getStatus(uuid)) !== 'RUNNING') {
          await detail.start();
        }
        await detail.expectStatus('RUNNING');
      });
    } finally {
      // Keep the runner tidy even though the VM is thrown away after the run.
      const created =
        uuid || (await apiClient.listServers()).find((s) => s.server_name === serverName)?.uuid;
      if (created) await apiClient.deleteServer(created).catch(() => {});
    }
  });
});
