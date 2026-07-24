import { test, runsOnlyWithInstall } from '@fixtures/index';
import { DesignSettingsPage, GeneralSettingsPage } from '@pages/index';
import { TEST_SERVER_MEMORY_LIMIT, TOSIOS_IMAGE } from '@helpers/constants';

/**
 * Feature: settings-design — general settings (server name) and the server-card
 * design both persist across a reload.
 *
 * A dedicated throwaway server is used, NOT the shared one: general settings are
 * only editable while the server is STOPPED, and renaming the shared server would
 * break the name-keyed get-or-create other specs rely on. A freshly created server
 * is stopped by default, so its name is immediately editable.
 */
test.describe('@extended settings-design', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 120_000 });

  test('server name and card design persist across reload', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const server = await apiClient.createServer({
      server_name: `st-settings-${Date.now()}`,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
    });
    const newName = `st-renamed-${Date.now()}`;
    const general = new GeneralSettingsPage(page, server.uuid);
    const design = new DesignSettingsPage(page, server.uuid);

    try {
      await test.step('When: renaming via general settings, Then: the name persists across reload', async () => {
        await general.navigate();
        await general.setServerName(newName);
        await page.reload();
        await general.expectServerName(newName);
      });

      await test.step('When: changing the card design to Castle, Then: it persists across reload', async () => {
        await design.navigate();
        await design.chooseDesign('Castle');
        await page.reload();
        await design.expectSelected('Castle');
      });
    } finally {
      await apiClient.deleteServer(server.uuid).catch(() => {});
    }
  });
});
