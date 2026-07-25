import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The home page: the pixel-art "server yard". Servers render as clickable houses;
 * a construction plot opens the create-server wizard. The left options banner
 * expands on interaction to reveal the user menu and logout.
 *
 * PERMISSION GATE (v1.1.0): the construction plot is rendered only when the user has
 * `canCreateGameServers`. A QUOTA_USER without it has no plot at all and a disabled
 * right-click menu entry — so any test user that needs to create a server must be
 * provisioned with `can_create_game_servers: true`.
 */
export class HomePage {
  constructor(private readonly page: Page) {}

  async navigate(): Promise<void> {
    await this.page.goto('/');
  }

  /** The construction plot link that opens the create-server modal. */
  private get constructionPlot(): Locator {
    return this.page.getByTestId('create-server-plot');
  }

  /** A server house by its name (aria.gameServer = "Game Server Configuration: {name}"). */
  serverHouse(serverName: string): Locator {
    // `data-testid="server-house"` is STATIC (one per house, not per uuid), so it
    // still has to be narrowed by the house's aria-label
    // (aria.gameServer = "Game Server Configuration: {name}").
    return this.page.getByTestId('server-house').and(
      this.page.getByRole('link', {
        name: new RegExp(`Game Server Configuration: ${escapeRegExp(serverName)}`),
      }),
    );
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
    await expect(this.page.getByTestId('login-open-btn')).toHaveCount(0, {
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }

  async expectLoggedOut(): Promise<void> {
    await expect(this.page.getByTestId('login-open-btn')).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }

  /**
   * Log out via the options banner. The banner (`#banner`) is collapsed until
   * interacted with, and the logout control is inert until then, so we click the
   * banner to expand before clicking logout.
   */
  async logout(): Promise<void> {
    await this.page.getByTestId('options-banner').click();
    await this.page.getByTestId('logout-btn').click();
    // Confirm in the LogOutAlertDialog. Both buttons used to be called "Log Out",
    // which the testids now disambiguate outright.
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await dialog.getByTestId('logout-confirm-btn').click();
    await this.expectLoggedOut();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
