import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage } from '@pages/index';

/**
 * Feature: server-from-template — create a server FROM a hosted catalog template
 * through the creation wizard (that UI path IS the feature) and confirm the server
 * was created carrying the template's docker image.
 *
 * Game choice: the step-1 game autocomplete queries the games API
 * (cosy-game-api / SteamGridDB), which is DISJOINT from the template service, so the
 * template's game must have a games-API presence to be selectable. Minecraft is such
 * a game, and its `itzg/minecraft-server` image is already pulled by the `rcon`
 * fixture (shared layers). The PaperMC template requires a `version` (no default) +
 * `memory` variable, both filled here so step 2 can advance.
 *
 * Scope: this spec proves CREATION from a template, not the boot. It asserts the
 * template prefilled step-3's docker image and that the created server opens — it
 * does NOT start the server or wait for RUNNING. Booting a real server is the heavy,
 * environment-sensitive part and is already covered by server-create (light tosios)
 * and server-lifecycle; keeping it out of this spec removes the Minecraft-boot
 * flakiness while still exercising the template UI end to end.
 */
test.describe('@extended server-from-template', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 240_000 });

  test('create a server from a catalog template (carries the template image)', async ({
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

      await test.step('When: creating a server from the Minecraft PaperMC catalog template', async () => {
        await create.createFromCatalogTemplate({
          serverName,
          game: /minecraft/i,
          template: /paper/i,
          templateVariables: { version: '1.21.5', memory: '2' },
          // The template's docker image is prefilled into step 3 (itzg/minecraft-server).
          expectImagePrefill: /minecraft-server/i,
        });
        await create.openCreatedServer();
      });

      uuid = await test.step('Then: the created server opens (created from the template)', async () => {
        await page.waitForURL(/\/server\/[^/]+/);
        const id = page.url().match(/\/server\/([^/?#]+)/)?.[1];
        expect(id, 'server uuid in URL').toBeTruthy();
        return id!;
      });
    } finally {
      // Never started, so this just removes the STOPPED record.
      const created =
        uuid || (await apiClient.listServers()).find((s) => s.server_name === serverName)?.uuid;
      if (created) await apiClient.deleteServer(created).catch(() => {});
    }
  });
});
