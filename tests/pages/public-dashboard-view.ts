import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { WS_MESSAGE_TIMEOUT_MS } from '@helpers/constants';

/**
 * The public dashboard, rendered from the normal server route with `?view=public`.
 * There is NO dedicated `/public/...` route: `/server/{uuid}/?view=public` is
 * reachable unauthenticated and renders the configured public widgets over the
 * public WS topics (see docs/testid-gaps.md, flow 7). Widget containers carry no
 * ids, so we assert on the inner metric titles ("CPU"/"Memory") and the log panel
 * header ("Console"), plus the server name (status header).
 */
export class PublicDashboardView {
  constructor(private readonly page: Page) {}

  /** Open the public dashboard for a server WITHOUT authenticating. */
  async openUnauthenticated(uuid: string): Promise<void> {
    await this.page.goto(`/server/${uuid}/?view=public`);
  }

  /** Assert the metric, log, and status widgets render for an unauthenticated viewer. */
  async expectWidgetsRendered(serverName: string): Promise<void> {
    // Status/header: the server's name is shown on the dashboard.
    await expect(this.page.getByText(serverName, { exact: false }).first()).toBeVisible({
      timeout: WS_MESSAGE_TIMEOUT_MS,
    });
    // Metric widget titles.
    await expect(this.page.getByText('CPU', { exact: true }).first()).toBeVisible({
      timeout: WS_MESSAGE_TIMEOUT_MS,
    });
    // Logs widget header.
    await expect(this.page.getByText('Console', { exact: false }).first()).toBeVisible({
      timeout: WS_MESSAGE_TIMEOUT_MS,
    });
  }

  /** Confirm the viewer is genuinely unauthenticated (login affordance present). */
  async expectUnauthenticated(): Promise<void> {
    await expect(this.page.getByRole('button', { name: 'Sign In' }).first()).toBeVisible({
      timeout: WS_MESSAGE_TIMEOUT_MS,
    });
  }
}
