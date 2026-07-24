import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS, UI_FLOW_TIMEOUT_MS } from '@helpers/constants';

/**
 * Server-settings page objects, one class per settings sub-route. All settings
 * screens share the `SettingsActionButtons` save bar: a primary "Confirm" button
 * (label toggles to "Saving...") and a "Revert" button; some screens raise a
 * confirmation dialog ("Warning" / "Sensitive Data Warning") before persisting.
 *
 * Release channel has no `data-testid`s. Many settings inputs come from
 * `InputFieldEditGameServer`, which passes a `header` but no `id`, so the label is
 * NOT associated — those fields are addressed by their placeholder text (see
 * docs/testid-gaps.md).
 */

/** Click the shared "Confirm" save button and dismiss any warning dialog. */
async function saveSettings(page: Page): Promise<void> {
  // TODO(testid): add data-testid="settings-confirm-btn" to SettingsActionButtons
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  // Some screens require an extra confirmation ("Save Anyway" for the public
  // dashboard's sensitive-data warning; "Confirm" inside a "Warning" dialog for
  // general settings). Dismiss it if present.
  const warning = page.getByRole('button', { name: /Save Anyway/ }).first();
  if (await warning.isVisible().catch(() => false)) {
    await warning.click();
  }
}

export class GeneralSettingsPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async navigate(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/settings/general`);
  }

  /** Server-name input — not label-associated, so matched by its placeholder. */
  private get serverNameInput(): Locator {
    // TODO(testid): add data-testid="settings-server-name-input"
    return this.page.getByPlaceholder('My Game Server');
  }

  /** Set the server name (the server must be STOPPED, or the field is disabled). */
  async setServerName(name: string): Promise<void> {
    await expect(this.serverNameInput).toBeEnabled({ timeout: UI_ACTION_TIMEOUT_MS });
    await this.serverNameInput.fill(name);
    await saveSettings(this.page);
  }

  async expectServerName(name: string): Promise<void> {
    await expect(this.serverNameInput).toHaveValue(name, { timeout: UI_FLOW_TIMEOUT_MS });
  }
}

export class DesignSettingsPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async navigate(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/settings/design`);
  }

  /**
   * A design tile button. Each tile is a `<button>` wrapping an `<img alt={label}>`
   * plus a `<span>{label}</span>`, so its accessible name is the label repeated
   * ("Castle Castle") — an `exact: true` match on just "Castle" finds nothing and
   * the click hangs until timeout. A non-exact (substring) match on the label is
   * robust and still disjoint between "House" and "Castle".
   */
  private designTile(label: 'House' | 'Castle'): Locator {
    // TODO(testid): add data-testid={`design-tile-${value}`} to DesignSettingsSection button
    return this.page.getByRole('button', { name: label }).first();
  }

  async chooseDesign(label: 'House' | 'Castle'): Promise<void> {
    await this.designTile(label).click();
    await saveSettings(this.page);
  }

  /**
   * Assert a design tile is the selected one. Selection carries no aria state; only
   * the selected tile gets the `bg-button-primary-default/30` class (the unselected
   * tile instead carries `hover:bg-button-primary-default/10`), so we match the
   * exact `/30` variant to distinguish them.
   */
  async expectSelected(label: 'House' | 'Castle'): Promise<void> {
    await expect(this.designTile(label)).toHaveClass(/bg-button-primary-default\/30/, {
      timeout: UI_FLOW_TIMEOUT_MS,
    });
  }
}

export class RconSettingsPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async navigate(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/settings/rcon`);
  }

  /** Enable RCON and set the port/password, then save. */
  async enableRcon(port: number, password: string): Promise<void> {
    // The toggle is a role=button wrapping a checkbox + "Enable RCON" label.
    // TODO(testid): add data-testid="rcon-enable-toggle"
    await this.page.getByRole('button', { name: 'Enable RCON' }).click();
    // Port/password inputs are not label-associated → placeholders.
    // TODO(testid): add data-testid="rcon-port-input" / "rcon-password-input"
    await this.page.getByPlaceholder('25575').fill(String(port));
    await this.page.getByPlaceholder('mysecretpassword').fill(password);
    await saveSettings(this.page);
  }
}

export class WebhooksSettingsPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async navigate(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/settings/webhooks`);
  }

  /**
   * Create a webhook through the modal. `typeOption` is the Select option label
   * ("Discord" / "Slack" / "n8n"); `events` are the event toggle names
   * ("Server Started" / "Server Stopped" / "Server Failed").
   */
  async createWebhook(opts: {
    url: string;
    typeOption: 'Discord' | 'Slack' | 'n8n';
    events: Array<'Server Started' | 'Server Stopped' | 'Server Failed'>;
  }): Promise<void> {
    // TODO(testid): add data-testid="webhook-create-btn" to WebhooksSettingsSection
    await this.page.getByRole('button', { name: 'Create Webhook' }).click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });

    // Type Select (real label association here).
    await dialog.getByLabel('Webhook Type').click();
    await this.page.getByRole('option', { name: opts.typeOption, exact: true }).click();

    // TODO(testid): add data-testid="webhook-url-input"
    await dialog.locator('#webhook-url').fill(opts.url);

    for (const event of opts.events) {
      // Event toggles are role=button wrapping a checkbox + label.
      await dialog.getByRole('button', { name: event, exact: true }).click();
    }

    // Submit (scope to the dialog so we don't match the page's own Create button).
    await dialog.getByRole('button', { name: 'Create Webhook' }).click();
    await expect(dialog).toBeHidden({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /** Assert the webhook list shows an entry for the given URL. */
  async expectWebhookListed(url: string): Promise<void> {
    await expect(this.page.getByText(url, { exact: false }).first()).toBeVisible({
      timeout: UI_FLOW_TIMEOUT_MS,
    });
  }
}

export class AccessManagementPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async navigate(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/settings/access-management`);
  }

  async createGroup(name: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Create new access group' }).click();
    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    // Group-name field is not label-associated → placeholder.
    await dialog.getByPlaceholder('Enter group name').fill(name);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /**
   * Select the group tab by its name. Each group renders as a Radix
   * `ToggleGroupItem` inside a `type="single"` `ToggleGroup` (AccessGroupList), and
   * Radix gives single-select items `role="radio"` (with `aria-checked`) — NOT
   * `role="button"` — so the old button locator never matched and hung to timeout.
   * The item's accessible name is exactly the group name (its only text child).
   */
  async selectGroup(name: string): Promise<void> {
    await this.page.getByRole('radio', { name, exact: true }).first().click();
  }

  async addMember(username: string): Promise<void> {
    await this.page.getByPlaceholder('Enter username').fill(username);
    await this.page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(this.page.getByText(username, { exact: false }).first()).toBeVisible({
      timeout: UI_FLOW_TIMEOUT_MS,
    });
  }

  /**
   * Toggle the given permission tiles on. "See Server" must be granted before the
   * others become enabled, so pass it first.
   *
   * Each permission (PermissionsSection) is a `<div role="button">` wrapping a
   * checkbox, a name span AND a description paragraph, so its accessible name is the
   * name and description concatenated (e.g. "See Server View the server in the
   * list. …"). An `exact: true` match on just the permission name therefore finds
   * nothing; a substring (non-exact) match on the name is robust and disjoint
   * between the permissions used here ("See Server" / "Read Server Logs").
   */
  async grantPermissions(permissionNames: string[]): Promise<void> {
    for (const name of permissionNames) {
      await this.page.getByRole('button', { name }).click();
    }
  }

  async save(): Promise<void> {
    await saveSettings(this.page);
  }
}

export class PublicDashboardSettingsPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async navigate(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/settings/public-dashboard`);
  }

  /** Flip the "Make Public Dashboard Visible" toggle on and save. */
  async makeVisibleAndSave(): Promise<void> {
    // TODO(testid): add data-testid="public-dashboard-visible-toggle"
    await this.page.getByRole('button', { name: 'Make Public Dashboard Visible' }).click();
    await saveSettings(this.page);
  }
}
