/**
 * Read-only Docker probe used to tell a SLOW server apart from a WEDGED backend.
 *
 * Cosy derives a game server's status from Docker asynchronously, so "the status is
 * still AWAITING_UPDATE" has two very different causes:
 *
 *   - the container genuinely is not up yet (cold pull, slow boot) → keep waiting;
 *   - the container IS up and the backend simply never learned about it → waiting is
 *     pointless, the backend has lost its Docker event stream.
 *
 * Only the real container state can distinguish those, so this module shells out to
 * the Docker CLI the runner already has (the same approach `webhook-sink.ts` uses to
 * discover the bridge gateway). It is DIAGNOSTIC ONLY — never an assertion source.
 * Specs still prove features through the UI; this exists so a timeout can name its
 * cause instead of reporting a bare "did not reach RUNNING within 300000ms".
 *
 * Everything degrades gracefully: if Docker is not queryable from the test process
 * (a remote `COSY_BASE_URL`, a locked-down runner) the probe reports `unavailable`,
 * no diagnosis is made, and callers fall back to plain timeout behaviour.
 */
import { execFileSync } from 'node:child_process';

import { EVENT_STREAM_WEDGE_GRACE_MS, GAME_SERVER_CONTAINER_PREFIX } from './constants';
// Type-only (erased at runtime) — api.ts imports this module, so a value import
// here would create a real cycle.
import type { GameServerStatus } from './api';

/** Never let a hung Docker CLI call eat a spec's budget. */
const DOCKER_PROBE_TIMEOUT_MS = 10_000;

/** Container name Cosy gives a game server (`cosy-<uuid>` by default). */
export function gameServerContainerName(serverUuid: string): string {
  return `${GAME_SERVER_CONTAINER_PREFIX}${serverUuid}`;
}

export type ContainerProbe =
  /** The Docker CLI could not be queried — no conclusion may be drawn. */
  | { kind: 'unavailable' }
  /** Docker answered, and no container exists for this server. */
  | { kind: 'absent' }
  /** Docker answered: a container exists in `state` (`running`, `exited`, …). */
  | { kind: 'present'; state: string; status: string };

/**
 * Look up the container backing `serverUuid`, including stopped ones (`-a`).
 * The uuid makes the name filter unambiguous, so a substring filter is enough.
 */
export function probeServerContainer(serverUuid: string): ContainerProbe {
  const name = gameServerContainerName(serverUuid);
  let raw: string;
  try {
    raw = execFileSync(
      'docker',
      ['ps', '-a', '--no-trunc', '--filter', `name=${name}`, '--format', '{{.State}}\t{{.Status}}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: DOCKER_PROBE_TIMEOUT_MS },
    );
  } catch {
    return { kind: 'unavailable' };
  }

  const line = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (!line) return { kind: 'absent' };

  const [state, status] = line.split('\t');
  return { kind: 'present', state: (state ?? '').trim(), status: (status ?? '').trim() };
}

/** Human-readable one-liner for error messages. */
export function describeProbe(probe: ContainerProbe): string {
  switch (probe.kind) {
    case 'unavailable':
      return 'container state unknown (Docker CLI not queryable from the test process)';
    case 'absent':
      return 'no container exists';
    case 'present':
      return `container state "${probe.state}" (${probe.status})`;
  }
}

/** Container state appended to an ordinary timeout so the artifact explains itself. */
export function containerStateHint(serverUuid: string): string {
  return `Container ${gameServerContainerName(serverUuid)}: ${describeProbe(
    probeServerContainer(serverUuid),
  )}.`;
}

// ── Docker-event-stream wedge detection ──────────────────────────────────────

/**
 * Cosy's backend moves a server AWAITING_UPDATE → RUNNING and STOPPING → STOPPED
 * **exclusively** from its single Docker `/events` subscription
 * (`DockerEventHandler.startEventListener()`, opened once in `@PostConstruct`).
 * That subscription is never restarted — `onError` only logs "Error in Docker event
 * listener" — and the persisted status is reconciled against real container state
 * only once, in `GameServerService.init()`. So if the stream ever ends, the backend
 * goes permanently blind: it keeps creating, starting and removing containers
 * correctly while every server's status freezes in its transitional state until the
 * backend restarts. See docs/KNOWN-ISSUES.md.
 *
 * The signature is unmistakable once the real container state is known:
 *
 *   | waiting for | actual container   | meaning                              |
 *   |-------------|--------------------|--------------------------------------|
 *   | RUNNING     | running            | the `start` event was never received |
 *   | STOPPED     | gone / not running | the `die` event was never received   |
 *
 * Waiting longer cannot help, so callers fail immediately with a message that names
 * the product bug — instead of burning the full 300 s budget three times over
 * (retries) and reporting a generic timeout that reads like a test flake.
 */
type MissedEvent = 'start' | 'die';

function wedgeDiagnosis(
  serverUuid: string,
  missedEvent: MissedEvent,
  observation: string,
): string | null {
  const probe = probeServerContainer(serverUuid);
  if (probe.kind === 'unavailable') return null;

  const containerIsUp = probe.kind === 'present' && probe.state === 'running';
  // Waiting for a start while no container runs yet is legitimate (it is being
  // created/pulled); waiting for a stop while it still runs is legitimate too.
  if (missedEvent === 'start' && !containerIsUp) return null;
  if (missedEvent === 'die' && containerIsUp) return null;

  return (
    `Cosy backend has LOST ITS DOCKER EVENT STREAM — this is a PRODUCT bug, not a test flake.\n` +
    `  ${observation}, but ${gameServerContainerName(serverUuid)}: ${describeProbe(probe)}.\n` +
    `  The backend acted on Docker correctly and then never received the "${missedEvent}" event, ` +
    `so the status can never advance.\n` +
    `  DockerEventHandler opens ONE /events subscription at startup and never restarts it ` +
    `(onError only logs "Error in Docker event listener"), and container state is reconciled ` +
    `only once, in GameServerService.init(). Any exception while handling a single event ends ` +
    `that subscription — typically a "die" for a server that was DELETED while running, whose ` +
    `row is gone by the time the event is handled. Every start/stop for the rest of this ` +
    `backend's lifetime will hang the same way; only a backend restart recovers it.\n` +
    `  Confirm in results/diagnostics/cosy-backend.log → "Error in Docker event listener". ` +
    `See docs/KNOWN-ISSUES.md ("backend loses the Docker event stream").`
  );
}

/**
 * Diagnosis for an API status poll that is stuck in a transitional state. Returns
 * `null` when nothing is provably wrong (still pulling, container genuinely not up
 * yet, or Docker not queryable from here).
 */
export function detectEventStreamWedge(
  serverUuid: string,
  status: GameServerStatus | undefined,
): string | null {
  if (status === 'AWAITING_UPDATE') {
    return wedgeDiagnosis(serverUuid, 'start', `Server ${serverUuid} reports ${status}`);
  }
  if (status === 'STOPPING') {
    return wedgeDiagnosis(serverUuid, 'die', `Server ${serverUuid} reports ${status}`);
  }
  return null;
}

/** Throw the wedge diagnosis once a transitional status has outlived the grace. */
export function assertNotWedged(
  serverUuid: string,
  status: GameServerStatus | undefined,
  elapsedMs: number,
): void {
  if (elapsedMs < EVENT_STREAM_WEDGE_GRACE_MS) return;
  const wedge = detectEventStreamWedge(serverUuid, status);
  if (wedge) throw new Error(wedge);
}

/**
 * Diagnosis for a UI status wait that timed out. The live indicator is driven by the
 * same persisted status over the WebSocket, so a UI that never shows "Running" while
 * the container runs is the very same wedge.
 */
export function detectUiStatusWedge(
  serverUuid: string,
  expected: 'RUNNING' | 'STOPPED',
): string | null {
  const observation = `The UI never showed ${expected} for server ${serverUuid}`;
  return expected === 'RUNNING'
    ? wedgeDiagnosis(serverUuid, 'start', observation)
    : wedgeDiagnosis(serverUuid, 'die', observation);
}
