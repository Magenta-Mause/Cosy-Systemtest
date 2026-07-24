import { test, runsOnlyWithInstall } from '@fixtures/index';
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
 */
test.describe('@extended rcon', () => {
  runsOnlyWithInstall();

  // The `minecraftServer` fixture boots a cold PaperMC server (image pull + world
  // gen), and that setup counts against this test's timeout, so the budget must fit
  // a full cold Minecraft boot. No cross-spec serialization is needed: rcon is now
  // the SUITE'S ONLY Minecraft boot — server-from-template switched to the tiny
  // TOSIOS catalog template — so there is no second concurrent PaperMC pull to
  // starve it on the 4-vCPU runner (the run-11/12 contention root cause).
  test.describe.configure({ timeout: 720_000 });

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
