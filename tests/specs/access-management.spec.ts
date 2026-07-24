import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { AccessManagementPage, ServerDetailPage } from '@pages/index';
import { TEST_SERVER_MEMORY_LIMIT, TOSIOS_IMAGE, UI_FLOW_TIMEOUT_MS } from '@helpers/constants';

/**
 * Feature: access-management — create an access group on a server, add a second
 * (non-admin) user, grant them a LIMITED set of permissions, and verify in that
 * user's own browser context that a permitted action works while a non-permitted
 * one is unavailable.
 *
 * Granted: "See Server" + "Read Server Logs" (permitted → the user can view the
 * server). NOT granted: "Start/Stop Server" (restricted → the start/stop control
 * is rendered but DISABLED for them, with a "no permission" tooltip).
 *
 * A dedicated throwaway server is used so the group + membership are torn down
 * simply by deleting the server (which cascades the access group). The second user
 * comes from the `secondUserContext` fixture (provisioned QUOTA_USER already
 * logged into its own context; deleted on teardown).
 */
test.describe('@extended access-management', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 180_000 });

  test('a group member is granted only the permissions they were given', async ({
    loggedInPage: page,
    apiClient,
    secondUserContext,
  }) => {
    const serverName = `st-access-${Date.now()}`;
    const server = await apiClient.createServer({
      server_name: serverName,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
    });
    const groupName = `st-group-${Date.now()}`;
    const access = new AccessManagementPage(page, server.uuid);

    try {
      await test.step('Given: admin creates a group, adds the user, grants See Server + Read Server Logs', async () => {
        await access.navigate();
        await access.createGroup(groupName);
        await access.selectGroup(groupName);
        await access.addMember(secondUserContext.user.username);
        // "See Server" first — it gates the other permission toggles.
        await access.grantPermissions(['See Server', 'Read Server Logs']);
        await access.save();
      });

      const otherPage = secondUserContext.page;

      await test.step('Then: the member can SEE the server (permitted action works)', async () => {
        await otherPage.goto(`/server/${server.uuid}`);
        await expect(otherPage.getByText(serverName, { exact: false }).first()).toBeVisible({
          timeout: UI_FLOW_TIMEOUT_MS,
        });
      });

      await test.step('Then: the member CANNOT start/stop it (control is present but disabled)', async () => {
        const otherDetail = new ServerDetailPage(otherPage, server.uuid);
        await otherDetail.expectStartStopControlDisabled();
      });
    } finally {
      await apiClient.deleteServer(server.uuid).catch(() => {});
    }
  });
});
