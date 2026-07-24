import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { WebhooksSettingsPage } from '@pages/index';
import {
  SERVER_STOP_TIMEOUT_MS,
  TEST_SERVER_MEMORY_LIMIT,
  TOSIOS_IMAGE,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
} from '@helpers/constants';

/**
 * Feature: webhooks — create a webhook (n8n type) through the settings UI pointing
 * at a local HTTP sink, trigger its subscribed event (server stop), and assert the
 * sink actually received the delivery.
 *
 * NETWORKING: the backend runs inside the compose network, so `localhost` there is
 * the container, not the runner host. The `webhookSink` fixture therefore binds to
 * 0.0.0.0 and hands out a URL whose host is the Docker bridge gateway (discovered
 * via `docker network inspect`), which is reachable from inside the backend
 * container. If delivery times out, the sink's error explains whether it is a
 * broken webhook or a runner-networking problem. See helpers/webhook-sink.ts.
 *
 * A dedicated throwaway server is used (not the shared one) so stopping it to fire
 * SERVER_STOPPED cannot race the specs that need the shared server running.
 */
test.describe('@extended webhooks', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 420_000 });

  test('a created webhook delivers the subscribed event to a local sink', async ({
    loggedInPage: page,
    apiClient,
    webhookSink,
  }) => {
    const serverName = `st-webhook-${Date.now()}`;
    const server = await apiClient.createServer({
      server_name: serverName,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
    });
    const webhooks = new WebhooksSettingsPage(page, server.uuid);

    try {
      await test.step('Given: the server is running', async () => {
        await apiClient.ensureRunning(server.uuid);
      });

      await test.step('When: creating an n8n webhook for "Server Stopped" pointing at the sink', async () => {
        await webhooks.navigate();
        await webhooks.createWebhook({
          url: webhookSink.url,
          typeOption: 'n8n',
          events: ['Server Stopped'],
        });
        await webhooks.expectWebhookListed(webhookSink.url);
      });

      await test.step('When: stopping the server to trigger the event', async () => {
        await apiClient.stopServer(server.uuid);
        await apiClient.waitForStatus(server.uuid, 'STOPPED', SERVER_STOP_TIMEOUT_MS);
      });

      await test.step('Then: the sink receives the delivery', async () => {
        const req = await webhookSink.waitForRequest(WEBHOOK_DELIVERY_TIMEOUT_MS);
        expect(req.method, 'webhook should be delivered as an HTTP request').toBe('POST');
      });
    } finally {
      await apiClient.deleteServer(server.uuid).catch(() => {});
    }
  });
});
