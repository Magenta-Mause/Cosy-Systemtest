import { test, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage } from '@pages/index';

/**
 * Feature: templates — the create-server wizard's catalog (backed by the hosted
 * template/game APIs) loads and offers the known games, and selecting one lists
 * its templates.
 *
 * HOSTED-SERVICE PATH: the single-host docker-compose install sets NO
 * `cosy.templates-api.url` / `cosy.games-api.url` override on the backend, so it
 * uses the application.yaml defaults, which point at the HOSTED public services
 * (cosy-templates.jannekeipert.de/v3/templates, cosy-game-api.jannekeipert.de).
 * This spec therefore intentionally exercises that real user path — a hosted-API
 * outage reds exactly this row (and games-search), which is the intended signal,
 * not a silent skip.
 *
 * Game display names come from the hosted GamesApi (IGDB-style), so only the
 * unambiguously-named games are asserted by name; cs2 and ark ship under their
 * catalog display names ("Counter-Strike 2", "ARK: Survival Evolved"). The
 * "catalog loads" proof is that Minecraft's templates render.
 */
test.describe('@extended templates', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 120_000 });

  test('the template catalog loads with the known games and their templates', async ({
    loggedInPage: page,
  }) => {
    const home = new HomePage(page);
    const create = new CreateServerPage(page);

    await test.step('Given: the create-server wizard is open', async () => {
      await home.navigate();
      await home.openCreateServerModal();
    });

    await test.step('Then: the catalog offers the known games', async () => {
      await create.expectGameOffered('minecraft');
      await create.expectGameOffered('terraria');
      await create.expectGameOffered('palworld');
    });

    await test.step('Then: selecting Minecraft lists its templates (catalog loaded)', async () => {
      await create.selectGame(/minecraft/i);
      await create.expectTemplateOptionsPresent();
    });
  });
});
