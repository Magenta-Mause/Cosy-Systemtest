import { test, runsOnlyWithInstall } from '@fixtures/index';
import { HomePage, LoginPage } from '@pages/index';

/**
 * Feature: auth — admin login with the credentials parsed from the installer's
 * stdout, identity-token refresh survives a reload (httpOnly refresh cookie), and
 * logout returns to the unauthenticated home.
 */
test.describe('@core auth', () => {
  runsOnlyWithInstall();

  test('login, token refresh on reload, logout', async ({ page, adminCreds }) => {
    const login = new LoginPage(page);
    const home = new HomePage(page);

    await test.step('Given: the unauthenticated home page', async () => {
      await home.navigate();
      await home.expectLoggedOut();
    });

    await test.step('When: logging in with the parsed admin credentials', async () => {
      await login.login(adminCreds.username, adminCreds.password);
    });

    await test.step('Then: the app is authenticated', async () => {
      await home.expectAuthenticated();
    });

    await test.step('When: reloading, Then: the session is refreshed (still authenticated)', async () => {
      await page.reload();
      await home.expectAuthenticated();
    });

    await test.step('When: logging out, Then: the login banner returns', async () => {
      await home.logout();
    });
  });
});
