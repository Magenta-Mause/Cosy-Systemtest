import { test, runsOnlyWithInstall } from '@fixtures/index';
import { CreateServerPage, HomePage } from '@pages/index';

/**
 * Feature: games-search — the game search in the create-server wizard returns
 * matching games WITH artwork for a query like "minecraft".
 *
 * Like `templates`, this exercises the HOSTED game-service path (the compose
 * install ships no games-api override, so the backend uses the hosted
 * cosy-game-api.jannekeipert.de default, which serves SteamGridDB artwork). A
 * hosted outage reds exactly this row — intended, not a silent skip.
 *
 * Artwork is asserted structurally: the game's sidebar button contains an <img>
 * (alt="") whose src is a non-empty artwork URL. The template cards themselves
 * carry no artwork (text-only), so artwork is asserted on the game entry.
 */
test.describe('@extended games-search', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 120_000 });

  test('game search returns results with artwork for "minecraft"', async ({
    loggedInPage: page,
  }) => {
    const home = new HomePage(page);
    const create = new CreateServerPage(page);

    await test.step('Given: the create-server wizard is open', async () => {
      await home.navigate();
      await home.openCreateServerModal();
    });

    await test.step('When: searching for "minecraft", Then: a result with artwork appears', async () => {
      await create.searchGames('minecraft');
      await create.expectGameHasArtwork('minecraft');
    });
  });
});
