import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The app-wide notification modal (`components/ui/notification-modal.tsx`) — a Radix
 * dialog the frontend raises for success/error/info. An error notification carries the
 * translated message plus a `<pre>` block of details extracted from the API error
 * envelope's `data` field, which is where a backend explanation actually reaches the
 * user.
 *
 * TODO(testid): the modal has no `data-testid` of its own, so it is addressed by
 * role. See docs/testid-gaps.md.
 */
export class NotificationDialog {
  constructor(private readonly page: Page) {}

  private get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  /** Wait for a notification whose details contain `detail` (e.g. the blocked port). */
  async expectErrorDetail(detail: string, timeout = UI_ACTION_TIMEOUT_MS): Promise<void> {
    await expect(this.dialog, 'no notification dialog appeared').toBeVisible({ timeout });
    await expect(
      this.dialog,
      `the notification did not explain the failure with "${detail}"`,
    ).toContainText(detail, { timeout });
  }

  /** Dismiss the notification so it stops covering the page underneath. */
  async dismiss(): Promise<void> {
    await this.dialog.getByRole('button').last().click();
    await expect(this.dialog).toBeHidden({ timeout: UI_ACTION_TIMEOUT_MS });
  }
}
