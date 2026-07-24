import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The home page: the pixel-art "server yard". Servers render as clickable houses;
 * a construction plot opens the create-server wizard. The left options banner
 * (`#banner`) expands on interaction to reveal the user menu and logout.
 *
 * No `data-testid`s exist yet — selectors lean on aria-labels the components
 * already expose (see docs/testid-gaps.md).
 */
export class HomePage {
  constructor(private readonly page: Page) {}

  async navigate(): Promise<void> {
    await this.page.goto('/');
  }

  /** The construction plot link that opens the create-server modal. */
  private get constructionPlot(): Locator {
    // Uses aria.createNewGameServer = "Create a new Game Server Configuration".
    // TODO(testid): add data-testid="create-server-plot" to ConstructionPlaceHouse link
    return this.page.getByRole('link', { name: 'Create a new Game Server Configuration' });
  }

  /** A server house by its name (aria.gameServer = "Game Server Configuration: {name}"). */
  serverHouse(serverName: string): Locator {
    // TODO(testid): add data-testid={`server-house-${uuid}`} to the server house link
    return this.page.getByRole('link', {
      name: new RegExp(`Game Server Configuration: ${escapeRegExp(serverName)}`),
    });
  }

  async openCreateServerModal(): Promise<void> {
    await this.constructionPlot.click();
    // The create dialog surfaces its title once open.
    await expect(
      this.page.getByRole('dialog').getByText('Create Server', { exact: true }).first(),
    ).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Robust navigation into a server detail page by UUID (avoids canvas houses). */
  async gotoServer(uuid: string): Promise<void> {
    await this.page.goto(`/server/${uuid}`);
  }

  /** True once the (only-when-unauthenticated) login banner is gone. */
  async expectAuthenticated(): Promise<void> {
    await expect(this.page.getByRole('button', { name: 'Sign In' })).toHaveCount(0, {
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }

  async expectLoggedOut(): Promise<void> {
    await expect(this.page.getByRole('button', { name: 'Sign In' }).first()).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }

  /**
   * Log out via the options banner. The banner (`#banner`) is collapsed until
   * interacted with, and the logout control is inert until then, so we click the
   * banner to expand before clicking logout.
   */
  async logout(): Promise<void> {
    // TODO(testid): add data-testid="options-banner" to OptionsBannerDropdown root
    await this.page.locator('#banner').click();
    // LogOutButton exposes aria-label "Log Out".
    // TODO(testid): add data-testid="logout-btn" to LogOutButton
    await this.page.getByRole('button', { name: 'Log Out' }).click();
    // Confirm in the LogOutAlertDialog (confirm button label "Log Out").
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await dialog.getByRole('button', { name: 'Log Out' }).click();
    await this.expectLoggedOut();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
