import { test, runsOnlyWithInstall } from '@fixtures/index';
import { PublicDashboardView } from '@pages/index';
import { SERVER_START_TIMEOUT_MS } from '@helpers/constants';

/**
 * Feature: public-dashboard — with a public dashboard configured for a server, a
 * FRESH UNAUTHENTICATED viewer can open it and see the status/metrics/logs widgets
 * rendered over the public WS topics.
 *
 * There is NO dedicated `/public/...` route: the public dashboard is the normal
 * server route with `?view=public`, reachable unauthenticated (see
 * docs/testid-gaps.md, flow 7). The layout is configured over the API (enable +
 * metric/log widgets) because the settings layout builder is drag-and-drop and not
 * reliably UI-drivable without test ids; the FEATURE proven here is that the
 * unauthenticated public view renders. The layout builder itself is a documented
 * selector gap.
 */
test.describe('@extended public-dashboard', () => {
  runsOnlyWithInstall();

  test.describe.configure({ timeout: 180_000 });

  test('an unauthenticated viewer sees the configured public dashboard widgets', async ({
    apiClient,
    sharedServer,
    browser,
  }) => {
    // NO client-supplied `uuid`: PublicDashboardLayout's id is a JPA
    // @GeneratedValue @Id, and the released frontend sends new widgets WITHOUT a
    // uuid (it lets the backend generate it). Supplying one makes Hibernate treat
    // the layout as a detached entity and the PATCH 500s. See docs/KNOWN-ISSUES.md.
    const layouts = [
      { size: 'MEDIUM', layout_type: 'METRIC', metric_type: 'CPU_PERCENT', title: 'CPU' },
      { size: 'MEDIUM', layout_type: 'METRIC', metric_type: 'MEMORY_PERCENT', title: 'Memory' },
      { size: 'LARGE', layout_type: 'LOGS', title: 'Logs' },
    ];

    try {
      await test.step('Given: the shared server is running with a public dashboard configured', async () => {
        if ((await apiClient.getStatus(sharedServer.uuid)) !== 'RUNNING') {
          await apiClient.startServer(sharedServer.uuid);
          await apiClient.waitForStatus(sharedServer.uuid, 'RUNNING', SERVER_START_TIMEOUT_MS);
        }
        await apiClient.setMetricLayout(sharedServer.uuid, [
          { size: 'MEDIUM', metric_type: 'CPU_PERCENT' },
          { size: 'MEDIUM', metric_type: 'MEMORY_PERCENT' },
        ]);
        await apiClient.setPublicDashboard(sharedServer.uuid, true, layouts);
      });

      const context = await browser.newContext();
      const anonPage = await context.newPage();
      try {
        const view = new PublicDashboardView(anonPage);

        await test.step('When: a fresh UNAUTHENTICATED context opens the public dashboard URL', async () => {
          await view.openUnauthenticated(sharedServer.uuid);
          await view.expectUnauthenticated();
        });

        await test.step('Then: the status/metrics/logs widgets render', async () => {
          await view.expectWidgetsRendered(sharedServer.server_name);
        });
      } finally {
        await context.close();
      }
    } finally {
      await apiClient.setPublicDashboard(sharedServer.uuid, false, []).catch(() => {});
    }
  });
});
