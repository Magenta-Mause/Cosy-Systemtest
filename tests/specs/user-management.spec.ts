import { test, runsOnlyWithInstall } from '@fixtures/index';
import { UsersPage } from '@pages/index';

/**
 * Feature: user-management — through the admin users UI: set a quota user's
 * docker-limits quota, change their role, and delete them.
 *
 * Order matters: the docker-limits ("Change Permissions") action is only offered
 * for QUOTA_USER, so the quota step runs before the promotion to Admin. The
 * subject user is provisioned over the API (invite → redeem → forced-change),
 * which is a precondition, not the feature under test.
 */
test.describe('@extended user-management', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 120_000 });

  test('set quota, change role, and delete a user via the users UI', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const username = `st-managed-${Date.now()}`;
    const user = await apiClient.provisionUser(username, 'Managed-Pw-123!');
    const users = new UsersPage(page);
    let deletedViaUi = false;

    try {
      await test.step('Given: a quota user exists and the admin opens the users UI', async () => {
        await users.navigate();
        await users.expectUserVisible(username);
      });

      await test.step('When: setting a docker-limits quota, Then: it persists', async () => {
        await users.setQuota(username, { cpu: '2', memoryMiB: '1024' });
        await users.expectQuotaCpu(username, '2');
      });

      await test.step('When: promoting the user to Admin, Then: the role badge updates', async () => {
        await users.changeRole(username, 'Admin');
        await users.expectRoleBadge(username, 'Admin');
      });

      await test.step('Then: the user can be deleted and is gone from the list', async () => {
        await users.deleteUser(username);
        deletedViaUi = true;
        await users.expectUserAbsent(username);
      });
    } finally {
      if (!deletedViaUi) await apiClient.deleteUser(user.uuid).catch(() => {});
    }
  });
});
