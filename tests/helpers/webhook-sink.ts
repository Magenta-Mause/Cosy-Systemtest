/**
 * Local HTTP sink for the `webhooks` feature test — proves Cosy actually delivers
 * a webhook over the network, not just that the CRUD endpoints accept one.
 *
 * NETWORKING: the Cosy backend runs inside the compose network (`cosy-network`),
 * while this sink runs on the CI runner host (the Playwright process). Inside the
 * container, `localhost` is the container itself — NOT the host — so the webhook
 * URL we register must use an address that resolves, from inside the container, to
 * the runner host. That address is the Docker bridge gateway of the network the
 * backend is attached to: a server bound to 0.0.0.0 on the host is reachable from
 * inside the container at the bridge gateway IP.
 *
 * We therefore:
 *   1. bind the sink to 0.0.0.0 (not 127.0.0.1) so the container can reach it, and
 *   2. discover the gateway at runtime via `docker inspect` (network of the
 *      `cosy-backend` container → its IPAM gateway), falling back to the default
 *      bridge gateway `172.17.0.1` if inspection is unavailable.
 *
 * If the backend cannot reach the sink the delivery wait times out; the spec turns
 * that into a red result with a message that explains the networking, so a genuine
 * "webhook delivery is broken" failure and a "runner networking is wrong" failure
 * stay distinguishable.
 */
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';

/** Container name the installer gives the backend (see docker-compose.yml). */
const BACKEND_CONTAINER = 'cosy-backend';

/** Default Docker bridge gateway — the fallback when inspection fails. */
const DEFAULT_BRIDGE_GATEWAY = '172.17.0.1';

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface WebhookSink {
  /**
   * URL to register in Cosy — reachable from inside the backend container. Points
   * at `http://<gateway>:<port><path>`.
   */
  readonly url: string;
  /** Wait until at least one request has arrived, or reject after `timeoutMs`. */
  waitForRequest(timeoutMs: number): Promise<ReceivedRequest>;
  /** Number of requests received so far. */
  count(): number;
  /** Stop listening. */
  close(): Promise<void>;
}

/**
 * Discover an address at which a host-bound (0.0.0.0) server is reachable from
 * inside the backend container: the gateway of the backend's Docker network.
 */
export function discoverBackendReachableHost(): string {
  try {
    const network = execFileSync(
      'docker',
      [
        'inspect',
        BACKEND_CONTAINER,
        '--format',
        '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\\n"}}{{end}}',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];

    if (network) {
      const gateway = execFileSync(
        'docker',
        [
          'network',
          'inspect',
          network,
          '--format',
          '{{range .IPAM.Config}}{{.Gateway}}{{end}}',
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (gateway) return gateway;
    }
  } catch {
    // docker not available (e.g. local dev without an install) — fall through.
  }
  return DEFAULT_BRIDGE_GATEWAY;
}

/**
 * Start a sink on an ephemeral port, bound to 0.0.0.0, and return its
 * container-reachable URL plus a delivery-wait helper.
 *
 * @param pathName request path the webhook should POST to (default `/cosy-hook`).
 */
export async function startWebhookSink(pathName = '/cosy-hook'): Promise<WebhookSink> {
  const received: ReceivedRequest[] = [];
  const waiters: Array<(r: ReceivedRequest) => void> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const record: ReceivedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      received.push(record);
      // Drain any pending waiter with this request.
      const waiter = waiters.shift();
      if (waiter) waiter(record);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Webhook sink failed to bind to an ephemeral TCP port.');
  }
  const host = discoverBackendReachableHost();
  const normalisedPath = pathName.startsWith('/') ? pathName : `/${pathName}`;
  const url = `http://${host}:${address.port}${normalisedPath}`;

  return {
    url,
    count: () => received.length,
    waitForRequest(timeoutMs: number): Promise<ReceivedRequest> {
      // Already have one buffered — resolve immediately (first unconsumed).
      if (received.length > waiters.length) {
        return Promise.resolve(received[received.length - 1]);
      }
      return new Promise<ReceivedRequest>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onReq);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `Webhook sink at ${url} received no request within ${timeoutMs}ms. ` +
                `Either delivery is broken, or the backend container cannot reach ` +
                `the sink — the URL host (${host}) must be the Docker bridge ` +
                `gateway reachable from inside "${BACKEND_CONTAINER}", and the sink ` +
                `must be bound to 0.0.0.0 (it is). Check "docker network inspect".`,
            ),
          );
        }, timeoutMs);
        const onReq = (r: ReceivedRequest): void => {
          clearTimeout(timer);
          resolve(r);
        };
        waiters.push(onReq);
      });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
