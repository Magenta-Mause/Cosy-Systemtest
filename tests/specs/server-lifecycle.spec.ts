import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { ServerDetailPage } from '@pages/index';
import { TEST_SERVER_MEMORY_LIMIT, TOSIOS_IMAGE } from '@helpers/constants';

/**
 * Feature: server-lifecycle — stop and start a running server through the UI and
 * observe the status transitions arrive live (the status indicator is driven by
 * the WebSocket store), then delete a server and confirm it is gone.
 *
 * Stop/start run against the shared tosios server; the delete step uses a
 * throwaway server so it does not disturb the console/files specs that reuse the
 * shared one.
 */
test.describe('@core server-lifecycle', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 480_000 });

  test('stop and start via UI reflect live status, then delete', async ({
    loggedInPage: page,
    apiClient,
    sharedServer,
  }) => {
    const detail = new ServerDetailPage(page, sharedServer.uuid);

    await test.step('Given: the shared server is running', async () => {
      // Bring it up over the API so the UI has a RUNNING server to act on.
      await apiClient.ensureRunning(sharedServer.uuid);
      await detail.gotoOverview();
      await detail.expectStatus('RUNNING');
    });

    await test.step('When: stopping via the UI, Then: the live status becomes STOPPED', async () => {
      await detail.stopAndWaitStopped();
    });

    await test.step('When: starting via the UI, Then: the live status becomes RUNNING', async () => {
      await detail.startAndWaitRunning();
    });

    await test.step('Then: a server can be deleted through the UI and is gone', async () => {
      const throwawayName = `systemtest-delete-${Date.now()}`;
      const throwaway = await apiClient.createServer({
        server_name: throwawayName,
        docker_image_name: TOSIOS_IMAGE,
        docker_image_tag: 'latest',
        memory_limit: TEST_SERVER_MEMORY_LIMIT,
      });

      const throwawayDetail = new ServerDetailPage(page, throwaway.uuid);
      await throwawayDetail.gotoOverview();
      await throwawayDetail.deleteViaUi(throwawayName);

      const stillThere = (await apiClient.listServers()).some((s) => s.uuid === throwaway.uuid);
      expect(stillThere, 'deleted server should be gone from the API listing').toBe(false);
    });
  });
});
