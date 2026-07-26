import { test, runsOnlyWithInstall } from '@fixtures/index';
import { NotificationDialog, ServerDetailPage } from '@pages/index';
import {
  PORT_CONFLICT_HOST_PORT,
  PORT_CONFLICT_NO_START_WINDOW_MS,
  TEST_SERVER_MEMORY_LIMIT,
  TOSIOS_CONTAINER_PORT,
  TOSIOS_IMAGE,
} from '@helpers/constants';

/**
 * Feature: port-conflict — a server whose host port is already taken is refused with
 * an explanation, instead of being handed to Docker and failing with an error nobody
 * can place.
 *
 * Two servers are provisioned over the API with the SAME host port; the first is
 * brought up so it really holds the port, then the second is started through the UI.
 * Both are throwaway servers: this spec must not race anything that needs the shared
 * server, and the port it fights over is its own (see PORT_CONFLICT_HOST_PORT).
 *
 * The conflict is proven twice over — the user gets told which port is blocked, and
 * the blocked server demonstrably never comes up.
 */
test.describe('@extended port-conflict', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 420_000 });

  test('a server whose host port is taken is refused with the port named', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const portMappings = [
      {
        instance_port: PORT_CONFLICT_HOST_PORT,
        container_port: TOSIOS_CONTAINER_PORT,
        protocol: 'TCP' as const,
      },
    ];

    const holder = await apiClient.createServer({
      server_name: `st-port-holder-${Date.now()}`,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
      port_mappings: portMappings,
    });
    const blocked = await apiClient.createServer({
      server_name: `st-port-blocked-${Date.now()}`,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
      port_mappings: portMappings,
    });

    const detail = new ServerDetailPage(page, blocked.uuid);
    const notification = new NotificationDialog(page);

    try {
      await test.step(`Given: a running server holds host port ${PORT_CONFLICT_HOST_PORT}`, async () => {
        await apiClient.ensureRunning(holder.uuid);
      });

      await test.step('When: starting a second server configured with the same host port', async () => {
        await detail.gotoOverview();
        await detail.expectStatus('STOPPED');
        await detail.start();
      });

      await test.step('Then: the UI names the blocked port', async () => {
        await notification.expectErrorDetail(`${PORT_CONFLICT_HOST_PORT}/TCP`);
        await notification.dismiss();
      });

      await test.step('Then: the blocked server never reaches RUNNING', async () => {
        await detail.expectStatusNeverBecomes('RUNNING', PORT_CONFLICT_NO_START_WINDOW_MS);
      });
    } finally {
      await apiClient.deleteServer(blocked.uuid).catch(() => {});
      await apiClient.deleteServer(holder.uuid).catch(() => {});
    }
  });
});
