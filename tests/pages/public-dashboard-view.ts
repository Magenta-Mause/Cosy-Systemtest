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

  /**
   * Confirm the viewer is genuinely unauthenticated. There is NO "Sign In"
   * affordance on this route (the login dialog lives only on the home route), and
   * the public view renders the full server-detail chrome INCLUDING the start/stop
   * control: the anonymous viewer is granted SEE_SERVER (so the button is not
   * hidden) but NOT START_STOP_SERVER, so GameServerStartStopButton renders it
   * DISABLED (only `disabled` is toggled — the button is always present). Assert the
   * control is present but disabled — an authenticated controller would see it
   * enabled. The label is "Shutdown" while the shared server runs / "Start" if
   * stopped, so match either.
   */
  async expectUnauthenticated(): Promise<void> {
    const control = this.page.getByRole('button', { name: /^(Start|Shutdown)$/ });
    await expect(control.first()).toBeVisible({ timeout: WS_MESSAGE_TIMEOUT_MS });
    await expect(control.first()).toBeDisabled({ timeout: WS_MESSAGE_TIMEOUT_MS });
  }
}
