// The entrypoint: start the forge on an ephemeral port, register it with the
// env, poll the env's done flag until the trial ends, then exit 0. The server
// stays up for the whole trial; this process is the server, not a script.

import { createApp } from './app.ts';
import { viewerLogin } from './scenario.ts';
import { Store } from './store.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (response.status === 200 || response.status === 409) return true;
    console.error(`register answered HTTP ${response.status}`);
    return false;
  } catch (err) {
    console.error(`register failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function isDone(): Promise<boolean> {
  try {
    const response = await fetch(`${ENV_URL}/done`);
    if (response.status !== 200) return false;
    const body = (await response.json()) as unknown;
    return (
      body !== null &&
      typeof body === 'object' &&
      (body as Record<string, unknown>).done === true
    );
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const store = new Store(viewerLogin());
  const server = createApp({ store, token: TOKEN });
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('the server did not bind a port');
    process.exit(1);
  }
  const port = address.port;
  console.error(`git-forge listening on port ${port} as ${store.viewerLogin}`);

  if (ENV_URL === '') {
    // No env to register with (a local smoke run): serve until killed.
    console.error('MAKEFUN_ENV_URL is not set; serving without registration');
    return;
  }

  // Register, retrying until the env accepts us.
  for (;;) {
    if (await register(port)) break;
    await sleep(500);
  }

  // Poll done until the trial ends, then exit 0.
  for (;;) {
    await sleep(500);
    if (await isDone()) break;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

process.on('SIGTERM', () => {
  process.exit(0);
});

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
