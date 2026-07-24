import { test, runsOnlyWithInstall, runsOnlyWithHeavyEnabled } from '@fixtures/index';
import { ConsolePage, RconSettingsPage, ServerDetailPage } from '@pages/index';
import {
  MINECRAFT_RCON_PASSWORD,
  MINECRAFT_RCON_PORT,
  RCON_RESPONSE_TIMEOUT_MS,
} from '@helpers/constants';

/**
 * Feature: rcon — enable RCON on the Minecraft server through the RCON settings UI,
 * send a command via the console, and observe the RCON response come back.
 *
 * The itzg image has RCON built in. The Cosy vanilla Minecraft template does NOT
 * wire RCON env, so the `minecraftServer` fixture creates the server with explicit
 * ENABLE_RCON / RCON_PORT (25575) / RCON_PASSWORD env; here we configure Cosy's
 * RCON with the SAME port/password so Cosy can connect and relay the command's
 * response back into the console/log stream. `/list` responds with
 * "There are N of a max of M players online".
 *
 * QUARANTINED on CI (`SYSTEMTEST_HEAVY`): across runs 12-15 the `minecraftServer`
 * fixture never got Minecraft to a stable RUNNING on a GitHub-hosted 4-vCPU runner —
 * through a ready-pattern audit, the OOM heap fix, a 600s global timeout and fully
 * serial execution with no competing pull — while burning ~20 min per run. The
 * nightly therefore reports rcon as SKIPPED (honest and visible in the matrix)
 * instead of a 20-minute red. RCON itself is consequently UNVERIFIED in CI. Run it
 * locally or on a beefier runner with `SYSTEMTEST_HEAVY=1`. See docs/KNOWN-ISSUES.md.
 */
test.describe('@extended rcon', () => {
  runsOnlyWithInstall();
  runsOnlyWithHeavyEnabled();

  // The `minecraftServer` fixture boots a cold PaperMC server (image pull + world
  // gen) and its setup counts against this test's timeout, so the budget fits a full
  // cold boot plus the RCON round-trip. rcon is the SUITE'S ONLY real Minecraft boot
  // (server-from-template no longer starts one), so there is no concurrent PaperMC
  // pull to starve it. The fixture's own ready wait is bounded (MINECRAFT_READY_TIMEOUT_MS
  // = 7 min) so a stuck boot fails cleanly with the last status rather than burning
  // this whole budget; the JVM heap was dropped below the container limit to remove
  // the OOM-crash-loop that kept it from reaching RUNNING. See docs/KNOWN-ISSUES.md.
  test.describe.configure({ timeout: 600_000 });

  test('enable RCON and send a command, then see the response', async ({
    loggedInPage: page,
    apiClient,
    minecraftServer,
  }) => {
    const rcon = new RconSettingsPage(page, minecraftServer.uuid);
    const detail = new ServerDetailPage(page, minecraftServer.uuid);
    const console = new ConsolePage(page);
    const RESPONSE_RE = /players online|There are \d+/i;

    await test.step('Given: the Minecraft server is running (fixture) and RCON is enabled via the UI', async () => {
      await rcon.navigate();
      await rcon.enableRcon(MINECRAFT_RCON_PORT, MINECRAFT_RCON_PASSWORD);
    });

    await test.step('When: sending `list` through the console', async () => {
      await detail.gotoConsole();
      await console.sendCommand('list');
    });

    await test.step('Then: the RCON response appears', async () => {
      // Authoritative: the response round-tripped through RCON into the log stream.
      await apiClient.waitForLogMatch(minecraftServer.uuid, RESPONSE_RE, RCON_RESPONSE_TIMEOUT_MS);
      // And it is visible in the console UI.
      await console.expectLogContains(RESPONSE_RE, RCON_RESPONSE_TIMEOUT_MS);
    });
  });
});
