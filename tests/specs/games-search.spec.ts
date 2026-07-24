import { test, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage } from '@pages/index';

/**
 * Feature: games-search — the game search in the create-server wizard returns
 * matching games for a query like "minecraft".
 *
 * Like `templates`, this exercises the HOSTED game-service path (the compose
 * install ships no games-api override, so the backend uses the hosted
 * cosy-game-api.jannekeipert.de default, which is backed by SteamGridDB). A hosted
 * outage reds exactly this row — intended, not a silent skip.
 *
 * The assertion is that a matching game result appears as a selectable option.
 * The released wizard's game list (5dba6e8) renders only the game name + template
 * count and surfaces NO artwork element, so artwork cannot be asserted structurally
 * here — see docs/KNOWN-ISSUES.md.
 */
test.describe('@extended games-search', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 120_000 });

  test('game search returns a matching result for "minecraft"', async ({
    loggedInPage: page,
  }) => {
    const home = new HomePage(page);
    const create = new CreateServerPage(page);

    await test.step('Given: the create-server wizard is open', async () => {
      await home.navigate();
      await home.openCreateServerModal();
    });

    await test.step('When: searching for "minecraft", Then: a matching game result appears', async () => {
      await create.searchGames('minecraft');
      await create.expectGameResult('minecraft');
    });
  });
});
