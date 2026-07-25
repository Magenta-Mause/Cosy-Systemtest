import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { LOGIN_TIMEOUT_MS, UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * Login is a dialog opened from the "Sign In" banner on the home page. The form
 * (`LoginForm` + `LoginDisplay`) has stable `id`s (`login-form`, `username`,
 * `password`) and its inputs carry accessible `<label>`s, so we select by label /
 * role. No `data-testid`s exist yet — see docs/testid-gaps.md.
 */
export class LoginPage {
  constructor(private readonly page: Page) {}

  /** The dialog that hosts the login form once opened. */
  private get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  private get usernameInput(): Locator {
    return this.dialog.getByTestId('login-username-input');
  }

  private get passwordInput(): Locator {
    return this.dialog.getByTestId('login-password-input');
  }

  private get submitButton(): Locator {
    // Footer submit button (type=submit, form="login-form"). Addressed by testid, not
    // label: since v1.1.0 a loading Button replaces its children with a loading label,
    // so the accessible name flips from "Sign In" to "Loading..." mid-submit.
    return this.dialog.getByTestId('login-submit-btn');
  }

  /** Banner button on the home page that opens the login dialog. */
  private get openLoginButton(): Locator {
    return this.page.getByTestId('login-open-btn');
  }

  async navigate(): Promise<void> {
    await this.page.goto('/');
  }

  async openDialog(): Promise<void> {
    await this.openLoginButton.click();
    await expect(this.dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Full UI login: open dialog, submit credentials, wait until authenticated. */
  async login(username: string, password: string): Promise<void> {
    await this.openDialog();
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
    // On success the dialog closes and the (only-when-unauthenticated) login
    // banner disappears.
    await expect(this.dialog).toBeHidden({ timeout: LOGIN_TIMEOUT_MS });
    await expect(this.openLoginButton).toHaveCount(0, { timeout: LOGIN_TIMEOUT_MS });
  }

  /** Assert the login form reports an incorrect-credentials error. */
  async expectLoginError(): Promise<void> {
    await expect(this.dialog.getByText('Incorrect username or password.')).toBeVisible({
      timeout: LOGIN_TIMEOUT_MS,
    });
  }
}
