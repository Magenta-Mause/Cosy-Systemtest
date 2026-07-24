import { test, runsOnlyWithInstall } from '@fixtures/index';
import { ConsolePage, ServerDetailPage } from '@pages/index';

/**
 * Feature: console — the live log stream in the console view shows container
 * output. Logs arrive over the WebSocket; tosios prints startup output shortly
 * after the container is up.
 */
test.describe('@core console', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 360_000 });

  test('the console shows live log output from the container', async ({
    loggedInPage: page,
    apiClient,
    sharedServer,
  }) => {
    const detail = new ServerDetailPage(page, sharedServer.uuid);
    const console = new ConsolePage(page);

    await test.step('Given: the shared server is running', async () => {
      await apiClient.ensureRunning(sharedServer.uuid);
      await detail.gotoOverview();
      await detail.expectStatus('RUNNING');
    });

    await test.step('When: opening the console, Then: live log output appears', async () => {
      await detail.gotoConsole();
      await console.expectHasLogOutput();
    });
  });
});
