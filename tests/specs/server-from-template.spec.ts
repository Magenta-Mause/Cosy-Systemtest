import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage, ServerDetailPage } from '@pages/index';
import { MINECRAFT_READY_TIMEOUT_MS } from '@helpers/constants';

/**
 * Feature: server-from-template — create a Minecraft server (itzg image) through
 * the template flow and wait until it is RUNNING and itzg reports readiness in the
 * logs. This is the heavyweight run (image pull + EULA + world generation); the
 * plan budgets 5-8 minutes, so a dedicated generous timeout is used.
 *
 * This spec drives its OWN creation through the UI template wizard (that UI path
 * IS the feature) and cleans up afterwards. The `rcon` spec does NOT reuse this
 * server — it uses the API-provisioned `minecraftServer` fixture — so the two
 * heavy specs stay independent of each other's execution order (Playwright runs
 * spec files in parallel across workers).
 */
test.describe('@extended server-from-template', () => {
  runsOnlyWithInstall();

  // Image pull + world gen dominate; allow well beyond the ready budget.
  //
  // retries: 0 — this is the single most expensive spec (a full Minecraft image
  // pull + world generation, ~10 min per attempt). Its failure modes (world-gen
  // overrunning the budget, hosted template API down) are NOT transient, so the
  // default CI retries would triple its ~10 min cost to ~30 min without changing
  // the outcome. Fail fast on the first attempt instead.
  test.describe.configure({ timeout: MINECRAFT_READY_TIMEOUT_MS + 120_000, retries: 0 });

  test('create a Minecraft server from a template and reach ready', async ({
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

      await test.step('When: creating a Minecraft server from the template flow', async () => {
        await create.createMinecraftFromTemplate({
          serverName,
          memoryMiB: '2048', // 2 GiB via the default MiB unit (min 6 MiB)
          version: '1.21.5',
          templateMemoryGiB: '2',
        });
        await create.openCreatedServerSlow();
      });

      uuid = await test.step('Then: the app opens the new server detail page', async () => {
        await page.waitForURL(/\/server\/[^/]+/, { timeout: MINECRAFT_READY_TIMEOUT_MS });
        const id = page.url().match(/\/server\/([^/?#]+)/)?.[1];
        expect(id, 'server uuid in URL').toBeTruthy();
        return id!;
      });

      await test.step('Then: it reaches RUNNING and itzg reports readiness in the logs', async () => {
        const detail = new ServerDetailPage(page, uuid);
        await detail.expectStatus('RUNNING', MINECRAFT_READY_TIMEOUT_MS);
        // itzg prints 'Done (…)! For help, type "help"' once the world is ready.
        await apiClient.waitForLogMatch(uuid, /Done \(|RCON running/i, MINECRAFT_READY_TIMEOUT_MS);
      });
    } finally {
      const created =
        uuid || (await apiClient.listServers()).find((s) => s.server_name === serverName)?.uuid;
      if (created) await apiClient.deleteServer(created).catch(() => {});
    }
  });
});
