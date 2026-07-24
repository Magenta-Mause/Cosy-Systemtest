import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS, WS_MESSAGE_TIMEOUT_MS } from '@helpers/constants';

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

  /**
   * Confirm the viewer is genuinely unauthenticated. There is NO "Sign In"
   * affordance on this route: the login dialog (LoginDisplay) is rendered only on
   * the home route, never on `/server/{uuid}`, so waiting for a "Sign In" button
   * here always timed out. The server-detail chrome DOES render for the public
   * view, but the start/stop control (GameServerStartStopButton) is hidden unless
   * the viewer holds the SEE_SERVER permission — which an unauthenticated viewer
   * does not — so it is absent. An authenticated owner opening the same page WOULD
   * see it. Assert neither the "Start" nor the "Shutdown" control is present.
   */
  async expectUnauthenticated(): Promise<void> {
    await expect(this.page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0, {
      timeout: UI_ACTION_TIMEOUT_MS,
    });
    await expect(this.page.getByRole('button', { name: 'Shutdown', exact: true })).toHaveCount(0, {
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }
}
