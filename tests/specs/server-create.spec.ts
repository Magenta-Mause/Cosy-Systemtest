import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage, ServerDetailPage } from '@pages/index';
import {
  SERVER_COLD_START_TIMEOUT_MS,
  TEST_SERVER_MEMORY_LIMIT,
  TOSIOS_IMAGE,
} from '@helpers/constants';

/**
 * Feature: server-create — create a server with a custom image through the UI
 * creation wizard and get it to RUNNING.
 *
 * In the released frontend (2659b07) a freshly created server is STOPPED ("ready
 * to be started"), so after the wizard we start it through the UI and assert the
 * live status reaches RUNNING — the full "user creates and runs a server" path.
 *
 * If the released create wizard blanks out with React #185 during input, the
 * CreateServerPage page object detects it and fails RED with a clear message
 * rather than a misleading timeout — see docs/KNOWN-ISSUES.md for the full
 * investigation (the crash was not reproducible from typing alone; the likely
 * trigger is an /api/auth/token refresh flipping the session mid-flow).
 */
test.describe('@core server-create', () => {
  runsOnlyWithInstall();

  // A cold Docker pull + start on a fresh runner needs a wide budget (and even
  // wider under the extended suite's concurrent image pulls — see constants).
  test.describe.configure({ timeout: 360_000 });

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
        // Created servers start out STOPPED in this release, but the freshly
        // created server may still be settling; wait until it is startable (so the
        // UI Start control is present and clickable) then start via the UI, unless
        // the backend already brought it up. The RUNNING wait uses the generous
        // cold-pull budget and naturally tolerates the AWAITING_UPDATE/PULLING_IMAGE
        // states the status indicator passes through under image-pull contention.
        if ((await apiClient.waitUntilStartable(uuid)) !== 'RUNNING') {
          await detail.start();
        }
        await detail.expectStatus('RUNNING', SERVER_COLD_START_TIMEOUT_MS);
      });
    } finally {
      // Keep the runner tidy even though the VM is thrown away after the run.
      const created =
        uuid || (await apiClient.listServers()).find((s) => s.server_name === serverName)?.uuid;
      if (created) await apiClient.deleteServer(created).catch(() => {});
    }
  });
});
