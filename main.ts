// Entrypoint for the github-core-clone-01 entry: the wire between this process and the trial env.
//
// The env owns the trial. This file's whole job is to speak its small lifecycle protocol:
//
//   1. MAKEFUN_ENV_URL points at the env (for example http://store:8080 in the trial container).
//      With no env there is nothing to serve a trial to, so a missing value exits 1 immediately.
//   2. The app server binds port 0 and the kernel picks a free port. Port 8080 is the env's own;
//      binding it (or any fixed port) would collide with the harness.
//   3. POST {env}/register with {"port": N} tells the env where to dial. The env keeps the first
//      registration it sees: 200 means ours landed, 409 means another process registered first and
//      this one simply waits like any other. 400/405 are contract violations and are fatal.
//   4. GET {env}/done is polled until it answers {"done": true}. The env answers at once, so the
//      poll is a loop with backoff, not a held-open request. This process must never exit before
//      the env says done — the export the scorer reads is written only after a clean finish.
//   5. On done: close the server and exit 0. Any fatal error exits 1 with the reason on stderr.
//
// Everything scored lives behind createApp() in app.ts; this file imports that and nothing else.

import { createApp } from './app.ts';

/** Raised when the env rejects the lifecycle itself (a 400/405 on register): retrying cannot help. */
class LifecycleError extends Error {}

/** How long a single register/done request may hang before it counts as a failed attempt. */
const REQUEST_DEADLINE_MS = 30_000;
/**
 * How long shutdown waits for the server's last sockets to drain before exiting anyway. The env
 * has already said done at that point, so a stuck keep-alive connection must not hold the exit
 * hostage — but a close that settles on its own is cleaner than abandoning the socket mid-flight.
 */
const CLOSE_GRACE_MS = 1_000;
/** Backoff between failed attempts: starts here, doubles per failure, never exceeds the cap. */
const BACKOFF_FLOOR_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Delay before the next retry, after `failures` consecutive failures: exponential, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FLOOR_MS * 2 ** Math.min(failures, 8));
}

/**
 * Announce the bound port until the env accepts the registration. A 200 (recorded) or 409
 * (someone registered first) ends the loop normally. A 400 or 405 means this process broke the
 * contract, so it is raised as a LifecycleError. Anything else — a refused connection while the
 * env is still starting, a timeout, a 5xx — is retried after a backoff.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new LifecycleError(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof LifecycleError) throw err;
      // Network-level failure: the env may not be up yet. Fall through to the backoff.
    }
    await pause(backoffMs(failures));
  }
}

/**
 * Poll the env's /done until it reports the trial is over. A non-OK status, an unparseable body,
 * or a failed request all mean "not done yet" — the only way out of this loop is done: true.
 */
async function awaitTrialEnd(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is unreachable or answered nonsense: not done. Keep polling.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind an ephemeral port and resolve with the port number the kernel chose. */
function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Close the server and let its remaining sockets drain, bounded by CLOSE_GRACE_MS. Resolves when
 * the close completes; if a peer is holding a connection open past the grace period, resolves
 * anyway — the trial is over either way, and the exit that follows ends the process regardless.
 */
function closeServer(server: ReturnType<typeof createApp>): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return Promise.race([closed, pause(CLOSE_GRACE_MS)]);
}

/** The process's whole life: bind, announce, wait for the env, close, exit. */
async function run(): Promise<void> {
  const server = createApp();
  const port = await bindEphemeral(server);
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitTrialEnd();
  // The env has released the trial: shut down tidily (bounded by closeServer's grace) so the
  // final log line and the socket teardown are never cut off by the exit that follows.
  await closeServer(server);
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
