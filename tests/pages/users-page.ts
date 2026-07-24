import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS, UI_FLOW_TIMEOUT_MS } from '@helpers/constants';

/**
 * The user-management page (`/users`, OWNER/ADMIN only). Covers creating an invite
 * (and reading the generated `?inviteToken=` link), and the per-user actions
 * reachable from each row's "More Options" menu: change role, change permissions
 * (quota), delete.
 *
 * No `data-testid`s on the release channel, so:
 *  - the invite trigger is matched by its aria-label ("Users").
 *  - the per-row menu trigger is icon-only with NO accessible name, so it is
 *    located structurally: the user's card (`[data-slot="card"]` containing the
 *    username) → its button (`[data-slot="button"]`). See docs/testid-gaps.md.
 */
export class UsersPage {
  constructor(private readonly page: Page) {}

  async navigate(): Promise<void> {
    await this.page.goto('/users');
  }

  private get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  /**
   * Create an invite for `username` (optionally with a role) and return the
   * redeem token parsed from the invite link the UI displays.
   *
   * @param roleOption the invite dialog's role option label ("User" = QUOTA_USER,
   *   "Admin" = ADMIN). Omit to leave the default.
   */
  async createInvite(username: string, roleOption?: 'User' | 'Admin'): Promise<string> {
    // Trigger button's accessible name is its aria-label "Users" (overrides the
    // visible "Invite User" text).
    // TODO(testid): add data-testid="invite-user-btn" to UserInviteButton
    await this.page.getByRole('button', { name: 'Users' }).click();
    await expect(this.dialog.getByText('Invite User', { exact: true })).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });

    // TODO(testid): add data-testid="invite-username-input"
    await this.dialog.locator('#invite-username').fill(username);

    if (roleOption) {
      // TODO(testid): add data-testid="invite-role-select"
      await this.dialog.locator('#invite-role').click();
      await this.page.getByRole('option', { name: roleOption, exact: true }).click();
    }

    // TODO(testid): add data-testid="invite-generate-btn"
    await this.dialog.getByRole('button', { name: 'Generate Invite' }).click();

    // Result view: the link is shown as select-all text `${origin}/?inviteToken=<key>`.
    await expect(this.dialog.getByText('Invite Created', { exact: true })).toBeVisible({
      timeout: UI_FLOW_TIMEOUT_MS,
    });
    const linkText = await this.dialog.getByText(/inviteToken=/).innerText();
    const token = linkText.match(/inviteToken=([^\s&"']+)/)?.[1];
    if (!token) {
      throw new Error(`Could not parse an invite token from the invite link: "${linkText}".`);
    }
    // Close the dialog so it doesn't shadow later interactions.
    await this.page.keyboard.press('Escape');
    return token;
  }

  /** A user's row card, located by the username it contains. */
  private userCard(username: string): Locator {
    // TODO(testid): add data-testid={`user-row-${uuid}`} to UserRow Card
    return this.page.locator('[data-slot="card"]').filter({ hasText: username });
  }

  async expectUserVisible(username: string): Promise<void> {
    await expect(this.userCard(username)).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async expectUserAbsent(username: string): Promise<void> {
    await expect(this.userCard(username)).toHaveCount(0, { timeout: UI_FLOW_TIMEOUT_MS });
  }

  /** The role badge text shown in the user's row (e.g. "Admin", "Quota User"). */
  async expectRoleBadge(username: string, badgeText: string): Promise<void> {
    await expect(this.userCard(username).getByText(badgeText, { exact: false })).toBeVisible({
      timeout: UI_FLOW_TIMEOUT_MS,
    });
  }

  /** Open the icon-only "More Options" menu for a user (structural locator). */
  private async openRowMenu(username: string): Promise<void> {
    // TODO(testid): add data-testid="user-row-menu-btn" to UserRow dots Button
    await this.userCard(username).locator('[data-slot="button"]').click();
  }

  /** Change a user's role via the row menu → "Change Role" dialog. */
  async changeRole(username: string, roleOption: 'Admin' | 'Quota User'): Promise<void> {
    await this.openRowMenu(username);
    await this.page.getByRole('menuitem', { name: 'Change Role' }).click();
    const dialog = this.dialog;
    await expect(dialog.getByText('Change Role', { exact: true })).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
    await dialog.getByRole('combobox').click();
    await this.page.getByRole('option', { name: roleOption, exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /**
   * Set a quota-user's docker limits via the row menu → "Change Permissions".
   * Values are the raw numeric strings for the CPU (cores) and Memory (MiB) inputs.
   */
  async setQuota(username: string, opts: { cpu?: string; memoryMiB?: string }): Promise<void> {
    await this.openRowMenu(username);
    await this.page.getByRole('menuitem', { name: 'Change Permissions' }).click();
    const dialog = this.dialog;
    await expect(dialog.getByText('Change Permissions', { exact: true })).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
    if (opts.cpu !== undefined) {
      await dialog.locator('#permissions-cpu-limit').fill(opts.cpu);
    }
    if (opts.memoryMiB !== undefined) {
      await dialog.locator('#permissions-memory-limit').fill(opts.memoryMiB);
    }
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /**
   * Verify a quota user's CPU-cores limit persisted, by reopening the Change
   * Permissions modal and reading the CPU input (a plain cores value, unlike the
   * memory field which carries a unit select). Cancels without changes.
   */
  async expectQuotaCpu(username: string, cpuCores: string): Promise<void> {
    await this.openRowMenu(username);
    await this.page.getByRole('menuitem', { name: 'Change Permissions' }).click();
    const dialog = this.dialog;
    await expect(dialog.locator('#permissions-cpu-limit')).toHaveValue(cpuCores, {
      timeout: UI_FLOW_TIMEOUT_MS,
    });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Delete a user via the row menu → "Delete User" confirmation. */
  async deleteUser(username: string): Promise<void> {
    await this.openRowMenu(username);
    await this.page.getByRole('menuitem', { name: 'Delete User' }).click();
    const dialog = this.dialog;
    await expect(dialog.getByText('Delete User', { exact: true })).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
    await dialog.getByRole('button', { name: 'Delete User', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_FLOW_TIMEOUT_MS });
  }
}

/**
 * The invite-redemption modal shown on `/` when `?inviteToken=<key>` is present.
 * Both password fields share the placeholder "Password", so they are addressed by
 * their ids (`#password` / `#confirmPassword`).
 */
export class InviteRedemptionPage {
  constructor(private readonly page: Page) {}

  /**
   * The invite-redemption dialog specifically (title "Accept Invitation"). Scoped
   * by title because on success the app opens a SECOND dialog — the global success
   * notification (`notificationModal.success` renders a Radix Dialog) — so an
   * unscoped `getByRole('dialog')` would match two elements and a `toBeHidden`
   * check on it would fail strict-mode ("2 dialogs visible").
   */
  private get dialog(): Locator {
    return this.page.getByRole('dialog').filter({ hasText: 'Accept Invitation' });
  }

  /** Open the redemption modal by visiting the invite link. */
  async open(token: string): Promise<void> {
    await this.page.goto(`/?inviteToken=${encodeURIComponent(token)}`);
    await expect(this.dialog).toBeVisible({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /**
   * Redeem the invite by choosing a username + password. On success the invite
   * modal closes and a success notification appears (the user is NOT
   * auto-logged-in); the caller then logs in normally.
   */
  async redeem(username: string, password: string): Promise<void> {
    const dialog = this.dialog;
    const usernameInput = dialog.locator('#username');
    // Username is prefilled + disabled when the inviter set one; only fill if editable.
    if (await usernameInput.isEnabled()) {
      await usernameInput.fill(username);
    }
    await dialog.locator('#password').fill(password);
    await dialog.locator('#confirmPassword').fill(password);
    await dialog.getByRole('button', { name: 'Create Account' }).click();
    await expect(dialog).toBeHidden({ timeout: UI_FLOW_TIMEOUT_MS });
  }
}
