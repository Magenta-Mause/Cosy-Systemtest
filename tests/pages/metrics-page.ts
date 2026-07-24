import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { METRICS_RENDER_TIMEOUT_MS } from '@helpers/constants';

/**
 * The metrics page (`/server/{uuid}/metrics`). One recharts area chart per entry in
 * the server's `metric_layout`; each is a Card whose title is the metric's display
 * name ("CPU", "Memory", …). The SVG chart itself carries no role/testid, so we
 * assert on the series titles (presence) and poll for a rendered recharts path as
 * evidence that data points have accrued (InfluxDB-backed; metrics need time).
 */
export class MetricsPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async navigate(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/metrics`);
  }

  private seriesTitle(name: string): Locator {
    // CardTitle is a styled div (not a heading), so match by text.
    // TODO(testid): add data-testid={`metric-card-${type}`} to MetricGraph Card
    return this.page.getByText(name, { exact: true });
  }

  /** Assert the CPU and Memory series are present (series presence, not values). */
  async expectSeriesPresent(): Promise<void> {
    await expect(this.seriesTitle('CPU').first()).toBeVisible({
      timeout: METRICS_RENDER_TIMEOUT_MS,
    });
    await expect(this.seriesTitle('Memory').first()).toBeVisible({
      timeout: METRICS_RENDER_TIMEOUT_MS,
    });
  }

  /**
   * Poll until at least one chart has rendered a data path — recharts only draws
   * `<path>` elements inside `.recharts-surface` once there is data to plot.
   */
  async expectDataPointsRendered(): Promise<void> {
    await expect
      .poll(async () => this.page.locator('.recharts-surface path').count(), {
        timeout: METRICS_RENDER_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);
  }
}
