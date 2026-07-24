import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage, ServerDetailPage } from '@pages/index';
import { TEST_SERVER_MEMORY_LIMIT, TOSIOS_IMAGE } from '@helpers/constants';

/**
 * Feature: server-create — create a server with a custom image through the UI
 * creation wizard and watch it reach RUNNING.
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

      await test.step('Then: the server reaches RUNNING', async () => {
        const detail = new ServerDetailPage(page, uuid);
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
