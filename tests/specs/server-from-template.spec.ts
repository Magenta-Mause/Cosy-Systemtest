import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage, ServerDetailPage } from '@pages/index';
import { SERVER_COLD_START_TIMEOUT_MS } from '@helpers/constants';

/**
 * Feature: server-from-template — create a server from a HOSTED catalog template
 * through the creation wizard (that UI path IS the feature) and confirm it runs.
 *
 * Uses the TOSIOS catalog template (game_id `tosios`, image
 * `halftheopposite/tosios`, 512MiB, no persistence). It is served by the same
 * hosted template service the fresh install fetches from. Chosen over a Minecraft
 * template because it has NO template variables — so step 2 has nothing to fill and
 * "Apply Template" enables the moment the template is selected — and it is a tiny
 * image that boots in seconds (no itzg/Paper world-gen), so this spec is now light
 * and rcon remains the sole Minecraft/RCON boot in the whole suite.
 *
 * Readiness = RUNNING: TOSIOS emits no itzg/Paper "Done" log line, so we assert the
 * live status reaches RUNNING (via the shared startable-aware start helper) rather
 * than a Minecraft-specific log match.
 */
test.describe('@extended server-from-template', () => {
  runsOnlyWithInstall();

  // Light now (tiny image); keep a wide budget for the cold pull + start under load.
  test.describe.configure({ timeout: 360_000 });

  test('create a server from a catalog template and reach RUNNING', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const home = new HomePage(page);
    const create = new CreateServerPage(page);
    const serverName = `st-from-template-${Date.now()}`;
    let uuid = '';

    try {
      await test.step('Given: the create-server wizard is open', async () => {
        await home.navigate();
        await home.openCreateServerModal();
      });

      await test.step('When: creating a server from the hosted TOSIOS catalog template', async () => {
        await create.createFromCatalogTemplate({
          serverName,
          game: /tosios/i,
          template: /tosios/i,
          expectImagePrefill: /tosios/i,
        });
        await create.openCreatedServer();
      });

      uuid = await test.step('Then: the app opens the new server detail page', async () => {
        await page.waitForURL(/\/server\/[^/]+/);
        const id = page.url().match(/\/server\/([^/?#]+)/)?.[1];
        expect(id, 'server uuid in URL').toBeTruthy();
        return id!;
      });

      await test.step('Then: the template server starts and reaches RUNNING', async () => {
        // Creating from a template is the feature; starting the created server is a
        // precondition (proven as a feature by server-lifecycle), so bring it up via
        // the startable-aware API helper, then confirm the live UI status is RUNNING.
        await apiClient.ensureRunning(uuid);
        const detail = new ServerDetailPage(page, uuid);
        await detail.expectStatus('RUNNING', SERVER_COLD_START_TIMEOUT_MS);
      });
    } finally {
      const created =
        uuid || (await apiClient.listServers()).find((s) => s.server_name === serverName)?.uuid;
      if (created) await apiClient.deleteServer(created).catch(() => {});
    }
  });
});
