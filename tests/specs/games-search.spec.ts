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
 * The assertion is that a matching game result appears as a selectable entry AND
 * that it carries real artwork.
 *
 * The artwork half is new in v1.1.0. The v1.0.3 wizard's game list rendered only the
 * name + template count and set no image slot, so artwork could not be asserted
 * structurally at all; the redesigned sidebar renders `game.logo_url`, falling back
 * to a local console icon when the games API returns none. Asserting the `<img>`
 * therefore proves the hosted API returned usable artwork, not merely that it
 * answered — which is the same "hosted path really works" signal this spec exists
 * for, one level stricter. A hosted outage reds this row; that is intended.
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

    await test.step('Then: the result carries artwork from the games API', async () => {
      await create.expectGameArtwork('minecraft');
    });
  });
});
