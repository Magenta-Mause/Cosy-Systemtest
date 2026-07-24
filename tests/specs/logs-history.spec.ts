import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { ConsolePage, ServerDetailPage } from '@pages/index';
import {
  LOGS_HISTORY_TIMEOUT_MS,
  SERVER_START_TIMEOUT_MS,
  SERVER_STOP_TIMEOUT_MS,
  TEST_SERVER_MEMORY_LIMIT,
  TOSIOS_IMAGE,
} from '@helpers/constants';

/**
 * Feature: logs-history — the Loki-backed history endpoint returns lines the
 * container produced earlier. Cosy has no separate "history" view (the console and
 * the history come from the same `useGameServerLogs` stream), so history is proven
 * by STOPPING the server first — with the container gone there is no live stream,
 * so any lines the console renders come from Loki history — and cross-checked
 * against the history endpoint as a fallback assert.
 *
 * Loki ingestion lags the live stream, so readiness is polled with a generous
 * budget. A dedicated throwaway server is used (not the shared one) so stopping it
 * cannot race the specs that need the shared server running.
 */
test.describe('@extended logs-history', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 240_000 });

  test('historical logs are returned after the server produced output', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const serverName = `st-logs-${Date.now()}`;
    const server = await apiClient.createServer({
      server_name: serverName,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
    });
    const detail = new ServerDetailPage(page, server.uuid);
    const console = new ConsolePage(page);

    try {
      await test.step('Given: the server ran and produced output ingested by Loki', async () => {
        await apiClient.startServer(server.uuid);
        await apiClient.waitForStatus(server.uuid, 'RUNNING', SERVER_START_TIMEOUT_MS);
        // Wait until at least one line is queryable from history (Loki ingestion).
        await apiClient.waitForLogMatch(server.uuid, /\S/, LOGS_HISTORY_TIMEOUT_MS);
      });

      await test.step('When: the server is stopped, remaining logs are historical', async () => {
        await apiClient.stopServer(server.uuid);
        await apiClient.waitForStatus(server.uuid, 'STOPPED', SERVER_STOP_TIMEOUT_MS);
      });

      await test.step('Then: the console renders the Loki-backed historical lines', async () => {
        await detail.gotoConsole();
        await console.expectHasLogOutput(LOGS_HISTORY_TIMEOUT_MS);
      });

      await test.step('And: the history endpoint returns past lines (fallback assert)', async () => {
        const lines = await apiClient.getLogs(server.uuid);
        expect(lines.length, 'history endpoint should return past log lines').toBeGreaterThan(0);
      });
    } finally {
      await apiClient.deleteServer(server.uuid).catch(() => {});
    }
  });
});
