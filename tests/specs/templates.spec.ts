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
 *
 * EXPECTED RED on released v1.0.3 — this spec is doing its job. Template selection is
 * genuinely broken in the release: Step2 compares the template's STRING `game_id`
 * ("minecraft") against the NUMERIC `external_game_id` from the games API, so no
 * template ever matches and step 2 always says "No templates are available". Fixed on
 * frontend main, unreleased. Do NOT weaken or skip this spec — it goes green by itself
 * once a release ships the fix. Full chain + evidence: docs/KNOWN-ISSUES.md
 * ("CONFIRMED PRODUCT BUG — catalog template selection").
 */
test.describe('@extended templates', () => {
  runsOnlyWithInstall();

  // Generous: the retry-tolerant game check re-queries the flaky hosted games API.
  test.describe.configure({ timeout: 180_000 });

  test('the template catalog loads with the known games and their templates', async ({
    loggedInPage: page,
  }) => {
    const home = new HomePage(page);
    const create = new CreateServerPage(page);

    await test.step('Given: the create-server wizard is open', async () => {
      await home.navigate();
      await home.openCreateServerModal();
    });

    await test.step('Then: the catalog offers a known game (hosted games API reachable)', async () => {
      // Assert ONE reliably-present game with retry rather than several: the hosted
      // games API is eventually-consistent / rate-limited under repeated searches, so
      // asserting three distinct games in a row flakes even when the catalog is up.
      await create.expectGameOfferedResilient('minecraft');
    });

    await test.step('Then: selecting Minecraft lists its templates (catalog loaded)', async () => {
      await create.selectGame(/minecraft/i);
      await create.expectTemplateOptionsPresent();
    });
  });
});
