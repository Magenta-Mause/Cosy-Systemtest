import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { ServerDetailPage } from '@pages/index';
import {
  BACKEND_DOCKER_RESPONSE_TIMEOUT_MS,
  EVENT_STREAM_IDLE_PROBE_MS,
  EVENT_STREAM_OBSERVE_TIMEOUT_MS,
  TEST_SERVER_MEMORY_LIMIT,
  TOSIOS_IMAGE,
  WS_MESSAGE_TIMEOUT_MS,
} from '@helpers/constants';
import { subscribedContainerEventsBetween } from '@helpers/docker';

/**
 * Feature: event-stream-recovery — the backend's Docker `/events` subscription must
 * survive an idle period.
 *
 * WHY THIS SPEC EXISTS. Every other spec exercises the event stream only *incidentally*,
 * back-to-back with other container activity, so a run can be green while the stream is
 * one quiet minute away from dying (run 17 was green, run 18 wedged four specs — same
 * code, same image). This spec removes the luck: it makes the quiet window happen ON
 * PURPOSE and then checks whether the backend still sees Docker.
 *
 * THE HYPOTHESIS UNDER TEST (docs/KNOWN-ISSUES.md, "backend loses the Docker event
 * stream"): the released backend builds ONE docker-java HTTP client with
 * `responseTimeout(45s)` — a socket READ timeout — and uses it for the long-lived
 * `/events` stream too. `/events` emits nothing while no container starts or dies, and
 * the daemon sends no keepalive, so a quiet window longer than 45 s trips a read timeout
 * on the stream. `DockerEventHandler` only logs that error (no reconnect, no watchdog,
 * `onComplete` unhandled) and statuses are reconciled against real container state
 * exactly once, in `GameServerService.init()` — so from that moment the backend is
 * permanently blind: it still creates/starts/stops containers correctly and never learns
 * that any of it happened.
 *
 * THE MECHANISM, in three moves:
 *
 *   1. CONTROL — bring a throwaway server to RUNNING. `AWAITING_UPDATE → RUNNING` has
 *      exactly one source (the `start` event), so reaching RUNNING *proves the stream was
 *      alive* at the start of the idle window. Without this the test could not tell
 *      "the idle killed it" from "it was already dead".
 *   2. PROVOKE — idle for EVENT_STREAM_IDLE_PROBE_MS (2× the backend's response timeout)
 *      with ZERO container lifecycle activity, then verify with `docker events` that the
 *      window really was quiet on the wire.
 *   3. DETECT — stop the server through the UI and require the backend to observe it
 *      within a SHORT budget. `RUNNING → STOPPING → STOPPED` needs no image pull and no
 *      container creation, so there is nothing legitimate left to be slow about; the
 *      `die` event is the only thing that can complete it.
 *
 * Stopping (not starting) is the provoked transition on purpose: it is the cheapest and
 * most deterministic lifecycle edge available — the container already exists, the image
 * is local, `docker stop` fires `die` within seconds — so a failure cannot be blamed on
 * a pull, on scheduling, or on `waitUntilStartable` racing a transitional state.
 *
 * ISOLATION. The spec provisions its OWN throwaway server (Phase-2 convention) and
 * performs no create/start/stop/delete between the control start and the provoked stop.
 * A *parallel* spec starting or stopping any container during the idle window would feed
 * the stream an event and silently invalidate the probe — CI runs serially
 * (`workers: 1`, see playwright.config.ts), which makes that impossible there; the
 * `docker events` replay in step 2 detects it anyway, on any machine.
 *
 * SIDE EFFECT, deliberately accepted: against a backend that still has the bug, this
 * spec *causes* the wedge rather than waiting to stumble into it, so the specs that run
 * after it will also fail — fast (≈45 s each) and with the same named diagnosis, thanks
 * to `helpers/docker.ts`. That is the honest reading of a broken build: the first red row
 * names the root cause instead of four later rows reporting mystery timeouts. To skip it
 * for a run: `npx playwright test --grep-invert event-stream-recovery`.
 */
test.describe('@extended event-stream-recovery', () => {
  runsOnlyWithInstall();

  // Control start (cold-pull tolerant) + idle + a short observation budget. Retries are
  // pointless here and actively harmful: the failure mode is permanent by definition —
  // once the stream is gone only a backend restart brings it back, so every retry pays
  // the full cost to re-report the same wedge (and would report it from the control step
  // instead of the assertion, obscuring it).
  test.describe.configure({ timeout: 420_000, retries: 0 });

  test('the backend still observes container transitions after an idle period', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const serverName = `st-eventstream-${Date.now()}`;
    const server = await apiClient.createServer({
      server_name: serverName,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
    });
    const detail = new ServerDetailPage(page, server.uuid);

    try {
      await test.step('Given: the server is RUNNING — the event stream is alive', async () => {
        // Reaching RUNNING is only possible via the Docker `start` event, so this is the
        // control: the stream demonstrably worked immediately before the idle window.
        await apiClient.ensureRunning(server.uuid);
        await detail.gotoOverview();
        await detail.expectStatus('RUNNING');
      });

      // Captured across the two steps below so the failure message can quote them.
      let idleWasQuiet: boolean | null = null;
      let idleEvents: string[] = [];

      await test.step(
        `When: nothing happens for ${EVENT_STREAM_IDLE_PROBE_MS / 1000}s (no container lifecycle activity)`,
        async () => {
          // +1s so the control `start` event, which may share this wall-clock second,
          // cannot be mistaken for activity *inside* the window.
          const windowStart = Math.floor(Date.now() / 1000) + 1;
          const startedAt = Date.now();

          // A real wall-clock wait is the point of this spec — there is nothing to poll
          // for. The page stays open so the WebSocket status channel is exercised across
          // the idle window too.
          await page.waitForTimeout(EVENT_STREAM_IDLE_PROBE_MS);

          const elapsedMs = Date.now() - startedAt;
          expect(
            elapsedMs,
            'the idle window must actually elapse — it is the provocation, not a pause',
          ).toBeGreaterThanOrEqual(EVENT_STREAM_IDLE_PROBE_MS);

          const windowEnd = Math.floor(Date.now() / 1000);
          const events = subscribedContainerEventsBetween(windowStart, windowEnd);
          // `null` = Docker not queryable from here; then we simply cannot verify
          // quietness and neither confirm nor deny the premise (same graceful
          // degradation as the wedge probe).
          idleWasQuiet = events === null ? null : events.length === 0;
          idleEvents = events ?? [];
          if (idleWasQuiet === false) {
            test.info().annotations.push({
              type: 'idle-window-polluted',
              description:
                `${idleEvents.length} container event(s) reached the backend's subscription during ` +
                `the idle window (${idleEvents.join(', ')}). They reset the stream's read deadline, ` +
                `so a PASS below does not prove the stream survives silence.`,
            });
          }
        },
      );

      await test.step('Then: a stop issued after the idle period is observed by the backend', async () => {
        // Stop through the UI (the user's path); the assertion is that the backend's
        // status machine — the thing the event stream feeds — actually advances.
        await detail.stop();
        try {
          await apiClient.waitForStatus(server.uuid, 'STOPPED', EVENT_STREAM_OBSERVE_TIMEOUT_MS);
        } catch (err) {
          throw new Error(idleProbeFailure(err, idleWasQuiet, idleEvents), { cause: err });
        }
        // And the live indicator reflects it, so the WebSocket status channel is proven
        // to still deliver after the idle window as well.
        await detail.expectStatus('STOPPED', WS_MESSAGE_TIMEOUT_MS);
      });
    } finally {
      await apiClient.deleteServer(server.uuid).catch(() => {});
    }
  });
});

/**
 * Name the hypothesis in the failure itself. `waitForStatus` already distinguishes the
 * two possible worlds via `assertNotWedged` — "the container never transitioned" (an
 * ordinary timeout, with the real container state appended) versus "the container
 * transitioned and the backend is blind" (the wedge diagnosis, the smoking gun) — so the
 * underlying error is quoted verbatim underneath rather than replaced.
 */
function idleProbeFailure(err: unknown, idleWasQuiet: boolean | null, idleEvents: string[]): string {
  const idleSeconds = EVENT_STREAM_IDLE_PROBE_MS / 1000;
  const quietness =
    idleWasQuiet === null
      ? 'could not be verified (Docker not queryable from the test process)'
      : idleWasQuiet
        ? 'CONFIRMED QUIET — the backend\'s subscription received no event at all, exactly the ' +
          'condition that trips the read timeout'
        : `NOT QUIET — ${idleEvents.length} event(s) arrived (${idleEvents.join(', ')}), which ` +
          'should have kept the stream alive; this failure is therefore worse than the ' +
          'hypothesis predicts';

  return (
    `backend did not observe the container transition after a ${idleSeconds}s idle period — ` +
    `the Docker event stream likely died and did not reconnect ` +
    `(see docs/KNOWN-ISSUES.md, "backend loses the Docker event stream").\n` +
    `  The same server reached RUNNING moments earlier, so the stream was alive before the ` +
    `idle window and only the silence is new.\n` +
    `  Idle window: ${quietness}.\n` +
    `  Hypothesis: the shared docker-java client applies a ` +
    `${BACKEND_DOCKER_RESPONSE_TIMEOUT_MS / 1000}s responseTimeout (a socket READ timeout) to the ` +
    `long-lived /events stream, so silence tears it down, and DockerEventHandler only logs the ` +
    `error instead of reconnecting.\n` +
    `  Confirm in results/diagnostics/cosy-backend.log → "Error in Docker event listener".\n` +
    `  Underlying failure: ${err instanceof Error ? err.message : String(err)}`
  );
}
