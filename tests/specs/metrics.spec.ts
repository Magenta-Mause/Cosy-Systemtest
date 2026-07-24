import { test, runsOnlyWithInstall } from '@fixtures/index';
import { MetricsPage } from '@pages/index';

/**
 * Feature: metrics — the metrics page renders the (InfluxDB-backed) CPU and Memory
 * series with accrued data points for a running server. Metrics need the container
 * running for a little while to accumulate (custom-metrics scrape period is 2 s),
 * so the assertions poll with a generous budget and check series PRESENCE + that a
 * chart path has rendered, not specific values.
 *
 * The metric layout is set over the API first so the CPU/Memory cards render
 * deterministically regardless of the server's default layout.
 */
test.describe('@extended metrics', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 360_000 });

  test('the metrics page renders CPU/Memory series with data points', async ({
    loggedInPage: page,
    apiClient,
    sharedServer,
  }) => {
    const metrics = new MetricsPage(page, sharedServer.uuid);

    await test.step('Given: the shared server is running with a CPU/Memory metric layout', async () => {
      await apiClient.ensureRunning(sharedServer.uuid);
      await apiClient.setMetricLayout(sharedServer.uuid, [
        { size: 'MEDIUM', metric_type: 'CPU_PERCENT' },
        { size: 'MEDIUM', metric_type: 'MEMORY_PERCENT' },
      ]);
    });

    await test.step('When: opening the metrics page, Then: CPU and Memory series are present', async () => {
      await metrics.navigate();
      await metrics.expectSeriesPresent();
    });

    await test.step('Then: the charts render accrued data points', async () => {
      await metrics.expectDataPointsRendered();
    });
  });
});
