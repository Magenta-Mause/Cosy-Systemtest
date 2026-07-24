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
    //
    // The `/users` route renders the UserTable TWICE — once in a mobile layout
    // (`lg:hidden`) and once in a desktop layout (`hidden lg:block`) — so every
    // user's card exists twice in the DOM (one hidden by CSS at any viewport).
    // A bare `hasText` filter therefore matches 2 elements and trips strict mode.
    // Restrict to the VISIBLE layout's card (at the 1280px test viewport that is
    // the desktop one); this keeps every card-derived locator (row menu, badges)
    // unambiguous regardless of which layout is active.
    return this.page
      .locator('[data-slot="card"]')
      .filter({ hasText: username })
      .filter({ visible: true });
  }

  async expectUserVisible(username: string): Promise<void> {
    // A freshly-provisioned user may not be in the client's cached user list yet:
    // UserTable renders from the `users` redux slice, which is populated by a fetch
    // that can lag an API-side create, so the row is briefly absent (run 12 found 0
    // cards). Reload /users to force a fresh fetch and retry until the (visible) card
    // appears, rather than failing on the first, possibly-stale, render.
    await expect(async () => {
      await this.page.reload();
      await expect(this.userCard(username)).toHaveCount(1, { timeout: UI_ACTION_TIMEOUT_MS });
    }).toPass({ timeout: UI_FLOW_TIMEOUT_MS });
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

  /**
   * Open the icon-only "More Options" menu for a user (structural locator).
   *
   * The trigger is `<DropdownMenuTrigger asChild><Button …>` — and Radix's `asChild`
   * merges the TRIGGER's props onto the child, so the rendered element carries
   * `data-slot="dropdown-menu-trigger"`, NOT the Button's `data-slot="button"`.
   * Querying `[data-slot="button"]` therefore matched nothing and `click()` waited
   * forever (run 16: 117s, the whole test timeout). Match the trigger slot instead.
   */
  private async openRowMenu(username: string): Promise<void> {
    // TODO(testid): add data-testid="user-row-menu-btn" to UserRow dots Button
    await this.userCard(username).locator('[data-slot="dropdown-menu-trigger"]').click();
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
   * Type into a CONTROLLED React number input at human cadence and assert it stuck.
   *
   * Both quota fields (CpuLimitInput / MemoryLimitInput) hold their text in local
   * component state (`localInputValue`) synced through an effect — the same fully
   * controlled pattern as the create wizard. Playwright `fill()` dispatches a single
   * synthetic `input` event, which does NOT reliably commit into that state: the
   * binding snaps the DOM value back, the modal saves the unchanged value, and the
   * persist re-read then waits forever (the run-15 120s timeout).
   * `pressSequentially` fires a real event per keystroke, like a user.
   */
  private async typeNumber(input: Locator, value: string, what: string): Promise<void> {
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.press('Delete');
    await input.pressSequentially(value, { delay: 60 });
    await expect(input, `${what}: value did not persist in the controlled input`).toHaveValue(
      value,
      { timeout: UI_ACTION_TIMEOUT_MS },
    );
  }

  /**
   * Set a quota-user's docker limits via the row menu → "Edit Resource Limits"
   * (the released UpdateDockerLimitsModal). `cpu` is plain cores; `memoryMiB` is the
   * NUMERIC part only — `#docker-memory-limit` is a compound number+unit widget
   * (number input + a MiB/GiB Select that defaults to MiB, emitting `${n}${unit}`),
   * exactly like the wizard's RAM field, so typing "512MiB" into it would be rejected.
   * Save button is "Save".
   */
  async setQuota(username: string, opts: { cpu?: string; memoryMiB?: string }): Promise<void> {
    await this.openRowMenu(username);
    // TODO(testid): add data-testid="user-edit-limits" to UserRow editDockerLimits item
    await this.page.getByRole('menuitem', { name: 'Edit Resource Limits' }).click();
    const dialog = this.dialog;
    await expect(dialog.getByText('Edit Resource Limits', { exact: true })).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
    if (opts.cpu !== undefined) {
      await this.typeNumber(dialog.locator('#docker-cpu-limit'), opts.cpu, 'CPU limit');
    }
    if (opts.memoryMiB !== undefined) {
      await this.typeNumber(
        dialog.locator('#docker-memory-limit'),
        opts.memoryMiB,
        'memory limit',
      );
    }
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /**
   * Verify a quota user's CPU-cores limit persisted, by reopening the "Edit Resource
   * Limits" modal and reading the CPU input (the modal seeds it from the user's saved
   * `docker_max_cpu_cores`). Cancels without changes.
   *
   * Retries around a RELOAD: the modal seeds from the `users` redux slice, which is
   * refreshed by a fetch that can lag the PATCH, so a straight reopen may still show
   * the pre-save value. Reloading forces a fresh fetch each attempt.
   */
  async expectQuotaCpu(username: string, cpuCores: string): Promise<void> {
    await expect(async () => {
      await this.page.reload();
      await this.openRowMenu(username);
      await this.page.getByRole('menuitem', { name: 'Edit Resource Limits' }).click();
      const dialog = this.dialog;
      await expect(dialog.locator('#docker-cpu-limit')).toHaveValue(cpuCores, {
        timeout: UI_ACTION_TIMEOUT_MS,
      });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
    }).toPass({ timeout: UI_FLOW_TIMEOUT_MS });
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
