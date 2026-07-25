import { test, runsOnlyWithInstall } from '@fixtures/index';
import { ServerDetailPage } from '@pages/index';
import {
  DELETE_WHILE_RUNNING_PROVOCATIONS,
  EVENT_STREAM_OBSERVE_TIMEOUT_MS,
  EVENT_STREAM_PROVOKE_SETTLE_MS,
  TEST_SERVER_MEMORY_LIMIT,
  TOSIOS_IMAGE,
  WS_MESSAGE_TIMEOUT_MS,
} from '@helpers/constants';
import type { GameServer } from '@helpers/api';
import { describeProbe, gameServerContainerName, probeServerContainer } from '@helpers/docker';

/**
 * Feature: event-stream-resilience — handling ONE bad container event must never cost
 * the backend its Docker `/events` subscription.
 *
 * WHY THIS SPEC EXISTS. Every other spec exercises the event stream only *incidentally*,
 * so a run can be green while one unlucky delete away from a backend that no longer sees
 * Docker at all (run 17 was green, run 18 wedged four specs — same code, same image).
 * This spec removes the luck: it performs the sequence that actually kills the stream and
 * then checks whether the backend still sees Docker.
 *
 * THE ROOT CAUSE (read off the backend log of a run in which the wedge happened):
 *
 *   ERROR c.m.c.s.e.docker.DockerEventHandler : Error in Docker event listener
 *   org.springframework.orm.ObjectOptimisticLockingFailureException:
 *     Unexpected row count (expected row count 1 but was 0) [update game_server_entity …]
 *   at … DockerEventHandler.handleDieEvent → notifyListeners
 *      → GameServerService.handleGameServerEngineEvent → handleGameServerEngineFailEvent
 *      → updateStatus → GameServerEntity
 *
 * A game server is DELETED while its container still runs. `deleteGameServerById` stops
 * and removes the container and only THEN deletes the row, so the container's `die` event
 * races the row's disappearance — and the pre-fix `DockerEventHandler` handled that event
 * on the docker-java callback thread with no isolation whatsoever. Three separate points
 * of the handler throw once the row is gone:
 *
 *   - `handleDieEvent` calls the server's status supplier, which is
 *     `getStatusFromEntity` → `getOrThrow` → **404 for a row that is already gone**;
 *   - the die is otherwise classified FAILED (the status is RUNNING, not STOPPING) and
 *     `updateStatus` writes to a row that vanishes before the flush →
 *     **`ObjectOptimisticLockingFailureException`** (the stack above);
 *   - and `updateStatus` ends in `GameServerWebhookService.dispatch`, which looks the
 *     server up again and **404s** if it disappeared during the write.
 *
 * Any of them escapes `notifyListeners` (a bare `forEach`, no try/catch), escapes
 * `onNext`, and ENDS the subscription. `onError` only logs; there is no reconnect and the
 * one-shot reconciliation in `GameServerService.init()` never runs again. From that moment
 * the backend is permanently blind: it keeps creating, starting, stopping and removing
 * containers correctly and never learns that any of it happened. It fired exactly once in
 * run 18 — that was enough.
 *
 * THE HYPOTHESIS THIS SPEC REPLACES — the previous version of this file idled for 90 s on
 * the theory that the backend's 45 s `responseTimeout` tears down a quiet `/events`
 * stream. **That theory did not explain the observed wedge:** a control run of the idle
 * spec against the pre-fix v1.0.3 backend (`sha-e200a4d`) PASSED — 90 s of silence did not
 * kill the stream. A guard that passes on the buggy build guards nothing, so the idle
 * machinery is gone. (The read timeout on long-lived streams was nonetheless real and was
 * also corrected by #119; it simply was not what wedged run 18.)
 *
 * THE MECHANISM, in three moves:
 *
 *   1. CONTROL — bring a server to RUNNING. `AWAITING_UPDATE → RUNNING` has exactly one
 *      source (the Docker `start` event), so reaching RUNNING *proves the stream was
 *      alive* going in. Without it, a failure could not be told apart from "it was already
 *      dead when this spec started". Every provocation server is likewise started BEFORE
 *      the first delete, so the whole setup is completed while the stream demonstrably
 *      works.
 *   2. PROVOKE — delete those servers while their containers are genuinely RUNNING, all at
 *      once. Both the count and the concurrency are load-bearing, not decoration: a single
 *      delete usually WINS the race (handling one event is a few DB round trips, while the
 *      delete still has a `docker ps` + `docker rm` to do before it commits), which is why
 *      the bug looked "intermittent" in the wild. But docker-java delivers events on ONE
 *      callback thread, so with `DELETE_WHILE_RUNNING_PROVOCATIONS` containers dying at
 *      once the k-th `die` is only finished at ~k × (handling cost) while every delete
 *      commits at about the same time, in parallel — so the later victims cannot win. See
 *      the constant's comment for the arithmetic.
 *   3. DETECT — perform an ordinary lifecycle transition on the SURVIVING control server
 *      (stop it) and require the backend to observe it within a SHORT budget. The victims
 *      are gone, so nothing about this transition is unusual: `RUNNING → STOPPING →
 *      STOPPED` needs no image pull and no container creation, and only the `die` event
 *      can complete it.
 *
 * Stopping (not starting) is the probe transition on purpose: it is the cheapest and most
 * deterministic lifecycle edge available — the container already exists, the image is
 * local, `docker stop` fires `die` within seconds — so a failure cannot be blamed on a
 * pull, on scheduling, or on `waitUntilStartable` racing a transitional state.
 *
 * ISOLATION. The spec provisions its OWN throwaway servers (Phase-2 convention) and never
 * touches the shared ones, so no other spec's server can be deleted or stopped by it.
 *
 * STATUS: expected GREEN since v1.1.0, which ships the fix (Cosy-Backend #119). The
 * handler now isolates each listener in its own try/catch, so a throw on one event can no
 * longer escape `onNext`, and a stream that does end is reconnected with backoff on a
 * dedicated thread followed by a reconciliation pass. A failure here is therefore a
 * REGRESSION of that fix, not the known bug.
 *
 * SIDE EFFECT, deliberately accepted: against a backend that still has the bug, this spec
 * *causes* the wedge rather than waiting to stumble into it, so the specs that run after it
 * will also fail — fast (≈45 s each) and with the same named diagnosis, thanks to
 * `helpers/docker.ts`. That is the honest reading of a broken build: the first red row
 * names the root cause instead of four later rows reporting mystery timeouts. This is why
 * the spec is kept as-is rather than retired now that the bug is fixed — it is the guard
 * that keeps it fixed. To skip it for a run:
 * `npx playwright test --grep-invert event-stream-resilience`.
 */
test.describe('@extended event-stream-resilience', () => {
  runsOnlyWithInstall();

  // Eleven cold-pull-tolerant starts + the deletes + a short observation budget (the image
  // is pulled at most once; the rest start from the local one in seconds). Retries are
  // pointless here and actively harmful: the failure mode is permanent by definition —
  // once the stream is gone only a backend restart brings it back, so every retry pays the
  // full cost to re-report the same wedge (and would report it from the control step
  // instead of the assertion, obscuring it).
  test.describe.configure({ timeout: 600_000, retries: 0 });

  test('the backend still observes container transitions after servers are deleted while running', async ({
    loggedInPage: page,
    apiClient,
  }) => {
    const stamp = Date.now();
    const control = await apiClient.createServer({
      server_name: `st-eventstream-control-${stamp}`,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: TEST_SERVER_MEMORY_LIMIT,
    });
    const detail = new ServerDetailPage(page, control.uuid);
    /** Provocation servers still alive — anything left here is cleaned up at the end. */
    const victims: GameServer[] = [];
    /**
     * How many victim containers Docker confirmed as "running" the moment before their
     * server was deleted (`null` = Docker not queryable from the test process, so the
     * provocation cannot be confirmed — the same graceful degradation as the wedge probe).
     */
    let confirmedRunning: number | null = null;

    try {
      await test.step('Given: a control server is RUNNING — the event stream is alive', async () => {
        // Reaching RUNNING is only possible via the Docker `start` event, so this is the
        // control: the stream demonstrably worked immediately before the provocation.
        await apiClient.ensureRunning(control.uuid);
        await detail.gotoOverview();
        await detail.expectStatus('RUNNING');
      });

      await test.step(
        `And: ${DELETE_WHILE_RUNNING_PROVOCATIONS} throwaway servers are RUNNING`,
        async () => {
          // All of them are started BEFORE any delete: a start that hangs here would mean
          // the stream was already dead, and this spec would then be reporting someone
          // else's wedge. Serially, so the starts cannot contend with each other.
          for (let i = 0; i < DELETE_WHILE_RUNNING_PROVOCATIONS; i++) {
            const victim = await apiClient.createServer({
              server_name: `st-eventstream-victim-${stamp}-${i}`,
              docker_image_name: TOSIOS_IMAGE,
              docker_image_tag: 'latest',
              memory_limit: TEST_SERVER_MEMORY_LIMIT,
            });
            victims.push(victim);
            await apiClient.ensureRunning(victim.uuid);
          }
        },
      );

      await test.step(
        `When: all ${DELETE_WHILE_RUNNING_PROVOCATIONS} are DELETED while their containers run`,
        async () => {
          // Read-only, diagnostic: lets the failure message state that the provocation was
          // the real thing (containers genuinely up at delete time), never an assertion.
          const probes = victims.map((victim) => probeServerContainer(victim.uuid));
          confirmedRunning = probes.every((probe) => probe.kind === 'unavailable')
            ? null
            : probes.filter((probe) => probe.kind === 'present' && probe.state === 'running').length;

          // Concurrently — see "PROVOKE" above: the single docker-java callback thread must
          // still be handling the first `die` while the other rows are already deleted.
          // A rejection is deliberately NOT swallowed: if a delete does not go through, the
          // provocation did not happen and a pass below would prove nothing.
          await Promise.all(victims.map((victim) => apiClient.deleteServer(victim.uuid)));
          // The backend removed them all, so only the control server needs cleaning up.
          victims.length = 0;

          // Let the `die` events land and be handled: the deletes return as soon as the
          // rows are gone, and it is the handling of the events that follows which either
          // survives or kills the subscription. Probing before that would test nothing.
          await page.waitForTimeout(EVENT_STREAM_PROVOKE_SETTLE_MS);
        },
      );

      await test.step('Then: a stop on the surviving control server is still observed', async () => {
        // Stop through the UI (the user's path); the assertion is that the backend's status
        // machine — the thing the event stream feeds — actually advances.
        await detail.stop();
        try {
          await apiClient.waitForStatus(control.uuid, 'STOPPED', EVENT_STREAM_OBSERVE_TIMEOUT_MS);
        } catch (err) {
          throw new Error(deleteWhileRunningFailure(err, control.uuid, confirmedRunning), {
            cause: err,
          });
        }
        // And the live indicator reflects it, so the WebSocket status channel is proven to
        // still deliver after the provocation as well.
        await detail.expectStatus('STOPPED', WS_MESSAGE_TIMEOUT_MS);
      });
    } finally {
      await apiClient.deleteServer(control.uuid).catch(() => {});
      for (const victim of victims) {
        await apiClient.deleteServer(victim.uuid).catch(() => {});
      }
    }
  });
});

/**
 * Name the mechanism in the failure itself, and quote the smoking gun.
 *
 * `waitForStatus` already distinguishes the two possible worlds via `assertNotWedged` —
 * "the container never stopped" (an ordinary timeout, with the real container state
 * appended) versus "the container stopped and the backend never heard" (the wedge) — so
 * the underlying error is quoted verbatim underneath rather than replaced. On top of that
 * we probe the control container ourselves, because whether it REALLY transitioned is the
 * difference between "the event stream is dead" and "the stop never happened".
 */
function deleteWhileRunningFailure(
  err: unknown,
  controlUuid: string,
  confirmedRunning: number | null,
): string {
  const probe = probeServerContainer(controlUuid);
  const smokingGun =
    probe.kind === 'unavailable'
      ? 'UNKNOWN — Docker is not queryable from the test process, so it cannot be confirmed ' +
        'that the container transitioned at all'
      : probe.kind === 'absent' || probe.state !== 'running'
        ? `YES — ${gameServerContainerName(controlUuid)}: ${describeProbe(probe)}. The container ` +
          'DID stop; the backend simply never heard about it. That is the wedge'
        : `NO — ${gameServerContainerName(controlUuid)}: ${describeProbe(probe)}. The container ` +
          'is still running, so the stop itself did not take effect — a DIFFERENT failure ' +
          'from the event-stream wedge';

  const provocation =
    confirmedRunning === null
      ? `${DELETE_WHILE_RUNNING_PROVOCATIONS} server(s) deleted at once; Docker is not queryable ` +
        'from the test process, so their container states could not be confirmed'
      : `${DELETE_WHILE_RUNNING_PROVOCATIONS} server(s) deleted at once, ${confirmedRunning} of ` +
        'them with a container Docker reported as "running" at that moment';

  return (
    `backend did not observe a normal stop after ${DELETE_WHILE_RUNNING_PROVOCATIONS} server(s) ` +
    `were deleted while running — a delete-while-running killed the Docker event subscription ` +
    `(see docs/KNOWN-ISSUES.md, "backend loses the Docker event stream").\n` +
    `  Mechanism: the deleted servers' containers emit "die" AFTER their rows are removed, so ` +
    `DockerEventHandler handles an event for a server that no longer exists — the status ` +
    `supplier 404s, or updateStatus writes 0 rows (ObjectOptimisticLockingFailureException). ` +
    `If that exception escapes onNext it ENDS the /events subscription and the backend is ` +
    `blind from then on. Cosy-Backend #119 (shipped in v1.1.0) isolates each listener in its ` +
    `own try/catch and reconnects with backoff, so seeing this message on v1.1.0 or later ` +
    `means that fix has REGRESSED — check DockerEventHandler.notifyListeners and the ` +
    `docker-event-reconnect thread first.\n` +
    `  The control server reached RUNNING moments earlier, so the stream was alive before the ` +
    `deletes and only they are new.\n` +
    `  Control container really transitioned: ${smokingGun}.\n` +
    `  Provocation: ${provocation}.\n` +
    `  Confirm in results/diagnostics/cosy-backend.log → "Error in Docker event listener" ` +
    `(the stack names DockerEventHandler.handleDieEvent → GameServerService.updateStatus).\n` +
    `  Underlying failure: ${err instanceof Error ? err.message : String(err)}`
  );
}
