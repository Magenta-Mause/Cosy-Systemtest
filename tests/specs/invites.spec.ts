import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { HomePage, InviteRedemptionPage, LoginPage, UsersPage } from '@pages/index';

/**
 * Feature: invites — an admin creates an invite in the users UI, the link is
 * redeemed in a SECOND, unauthenticated browser context with a fresh
 * username/password, and the new user can then log in and lands in the UI.
 *
 * NOTE on "forced password change on first login": UserInviteService builds the
 * redeemed user with `defaultPasswordReset(true)`, but that flag is never read by
 * the backend and no change-password step is surfaced by the frontend (verified —
 * the getter has zero usages, and there is no first-login dialog). It is a dormant
 * no-op today, so the real user path is redeem → normal login. This spec proves
 * that reachable path and the gap is recorded in docs/testid-gaps.md.
 */
test.describe('@extended invites', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 120_000 });

  test('admin creates an invite; it is redeemed and the new user lands in the UI', async ({
    loggedInPage: page,
    apiClient,
    browser,
  }) => {
    const invitedUsername = `st-invitee-${Date.now()}`;
    const invitedPassword = 'Invitee-Pw-123!';
    const users = new UsersPage(page);
    let token = '';

    try {
      await test.step('Given: the admin creates an invite in the users UI', async () => {
        await users.navigate();
        token = await users.createInvite(invitedUsername, 'User');
        expect(token, 'invite token parsed from the displayed invite link').toBeTruthy();
      });

      const secondContext = await browser.newContext();
      const secondPage = await secondContext.newPage();
      try {
        await test.step('When: opening the invite link in a fresh context and redeeming it', async () => {
          const redeem = new InviteRedemptionPage(secondPage);
          await redeem.open(token);
          await redeem.redeem(invitedUsername, invitedPassword);
        });

        await test.step('Then: the new user can log in and reaches the authenticated UI', async () => {
          const login = new LoginPage(secondPage);
          await login.navigate();
          await login.login(invitedUsername, invitedPassword);
          await new HomePage(secondPage).expectAuthenticated();
        });
      } finally {
        await secondContext.close();
      }
    } finally {
      // Clean up the invited user via the admin API (throwaway VM, but tidy).
      const created = (await apiClient.listUsers()).find((u) => u.username === invitedUsername);
      if (created) await apiClient.deleteUser(created.uuid).catch(() => {});
    }
  });
});
