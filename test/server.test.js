import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const token = 'a'.repeat(64);
async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function launch(extraEnv = {}) {
  const port = await freePort();
  const processHandle = spawn(process.execPath, ['server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: String(port), UPDATE_TOKEN: token, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let processOutput = '';
  processHandle.stderr.on('data', x => { processOutput += x.toString(); });
  processHandle.stdout.on('data', x => { processOutput += x.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error(`App terminated unexpectedly: ${processOutput}`);
    try { const response = await fetch(origin + '/healthz'); if (response.ok) return { origin, processHandle }; } catch {}
    await new Promise(r => setTimeout(r, 40));
  }
  processHandle.kill();
  throw new Error(`Server did not start: ${processOutput}`);
}

async function stop(instance) {
  instance.processHandle.kill('SIGTERM');
  await new Promise(resolve => {
    if (instance.processHandle.exitCode !== null || instance.processHandle.signalCode !== null) resolve();
    else instance.processHandle.once('exit', resolve);
  });
}

// Verify an orderly exit instead of just observing that the process died.
async function expectGracefulStop(child, signal, maxMs = 2000) {
  let timer;
  const exited = new Promise(resolve => child.once('exit', (code, receivedSignal) => {
    resolve({ code, receivedSignal });
  }));
  try {
    assert.equal(child.kill(signal), true);
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Server ignored ${signal} for ${maxMs}ms`)), maxMs);
      }),
    ]);
    assert.deepEqual(result, { code: 0, receivedSignal: null });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

test('SIGTERM and SIGINT shut down promptly without an init process', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const app = await launch();
    await (await fetch(app.origin + '/api/status')).json();
    await expectGracefulStop(app.processHandle, signal);
  }
});

test('SIGTERM bounds shutdown while an HTTP request remains unfinished', async () => {
  const app = await launch();
  const socket = net.createConnection({
    host: '127.0.0.1', port: Number(new URL(app.origin).port),
  });
  socket.on('error', () => {}); // Shutdown deliberately drops this incomplete request.
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write('POST /api/ha-update HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 1024\r\n\r\n' +
      '{');
    // Give the server time to begin reading the incomplete request.
    await new Promise(resolve => setTimeout(resolve, 100));
    await expectGracefulStop(app.processHandle, 'SIGTERM', 5000);
  } finally {
    socket.destroy();
    if (app.processHandle.exitCode === null && app.processHandle.signalCode === null) {
      app.processHandle.kill('SIGKILL');
    }
  }
});

async function post(origin, value, bearer = token, contentType = 'application/json') {
  return fetch(origin + '/api/ha-update', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': contentType },
    body: JSON.stringify(value),
  });
}

test('production status is safe before first update and accepts only signed fixed choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'may-i-come-'));
  const file = join(dir, 'status.json');
  const instance = await launch({ DATA_FILE: file });
  try {
    const initial = await fetch(instance.origin + '/api/status');
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.equal(initial.headers.get('access-control-allow-origin'), null);
    assert.equal((await initial.json()).status, 'Absolutely not');

    const denied = await post(instance.origin, { status: 'Visitors welcome' }, 'wrong');
    assert.equal(denied.status, 401);
    const invalid = await post(instance.origin, { status: 'On the way!' });
    assert.equal(invalid.status, 400);
    const wrongContentType = await post(instance.origin, { status: 'Ask first' }, token, 'text/plain');
    assert.equal(wrongContentType.status, 415);

    const approved = await post(instance.origin, { status: 'Ask first' });
    assert.equal(approved.status, 200);
    const state = await (await fetch(instance.origin + '/api/status')).json();
    assert.equal(state.status, 'Ask first');
    assert.ok(Date.parse(state.updatedAt) > 0);
    assert.equal(state.connected, true);
    await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' }, 'stateless app must not write a status file');

    const traversal = await fetch(instance.origin + '/%2e%2e/server.js');
    assert.equal(traversal.status, 404);
    const javascript = await fetch(instance.origin + '/app.js');
    assert.equal(javascript.status, 200);
    assert.match(await javascript.text(), /Absolutely not/);
  } finally {
    await stop(instance);
  }
  const restart = await launch({ DATA_FILE: file });
  try {
    const data = await (await fetch(restart.origin + '/api/status')).json();
    assert.equal(data.status, 'Absolutely not');
    assert.equal(data.connected, false);
    assert.equal(data.updatedAt, null);
  } finally {
    await stop(restart);
    await rm(dir, { recursive: true, force: true });
  }
});

test('demo lets visitors preview without enabling updates', async () => {
  const app = await launch({ DEMO_MODE: 'true', UPDATE_TOKEN: '' });
  try {
    const yes = await (await fetch(app.origin + '/api/status?demo=yes')).json();
    assert.equal(yes.status, 'Visitors welcome');
    assert.equal(yes.demo, true);
    const update = await post(app.origin, { status: 'Visitors welcome' });
    assert.equal(update.status, 403);
  } finally {
    await stop(app);
  }
});


test('offline heartbeat expiry overrides permissive in-memory status, including restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'may-i-come-expiry-'));
  const file = join(dir, 'status.json');
  let app = await launch({ DATA_FILE: file, STATUS_TTL_SECONDS: '0.3' });
  try {
    const first = await post(app.origin, { status: 'Visitors welcome' });
    assert.equal(first.status, 200);
    const fresh = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(fresh.status, 'Visitors welcome');
    assert.equal(fresh.connected, true);
    const decisionAt = fresh.updatedAt;

    await new Promise(resolve => setTimeout(resolve, 100));
    const heartbeat = await post(app.origin, { status: 'Visitors welcome' });
    assert.equal(heartbeat.status, 200);
    const stillFresh = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(stillFresh.updatedAt, decisionAt, 'heartbeat should not count as a decision change');

    await new Promise(resolve => setTimeout(resolve, 350));
    const expired = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(expired.status, 'Absolutely not');
    assert.equal(expired.connected, false);
    assert.equal(expired.updatedAt, null);
  } finally {
    await stop(app);
  }

  app = await launch({ DATA_FILE: file, STATUS_TTL_SECONDS: '0.3' });
  try {
    const afterRestart = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(afterRestart.status, 'Absolutely not');
    assert.equal(afterRestart.connected, false);
    const recovered = await post(app.origin, { status: 'Ask first' });
    assert.equal(recovered.status, 200);
    assert.equal((await (await fetch(app.origin + '/api/status')).json()).status, 'Ask first');
  } finally {
    await stop(app);
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy saved status files are ignored and start fail-closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'may-i-come-legacy-'));
  const file = join(dir, 'status.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify({ status: 'Visitors welcome', updatedAt: new Date().toISOString() }));
  const app = await launch({ DATA_FILE: file });
  try {
    const state = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(state.status, 'Absolutely not');
    assert.equal(state.connected, false);
  } finally {
    await stop(app);
    await rm(dir, { recursive: true, force: true });
  }
});


test('missing or unreadable update token keeps website healthy and verdict closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'may-i-come-token-'));
  const secretFile = join(dir, 'update-token.txt');
  const dataFile = join(dir, 'missing-data-volume', 'status.json');
  const app = await launch({ UPDATE_TOKEN_FILE: secretFile, DATA_FILE: dataFile });
  try {
    assert.equal((await fetch(app.origin + '/healthz')).status, 200);
    const before = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(before.status, 'Absolutely not');
    assert.equal(before.connected, false);
    assert.equal((await post(app.origin, { status: 'Visitors welcome' })).status, 503);

    await writeFile(secretFile, 'short-token');
    assert.equal((await post(app.origin, { status: 'Visitors welcome' })).status, 503);
    assert.equal((await (await fetch(app.origin + '/api/status')).json()).status, 'Absolutely not');

    await writeFile(secretFile, token);
    assert.equal((await post(app.origin, { status: 'Visitors welcome' })).status, 200);
    assert.equal((await (await fetch(app.origin + '/api/status')).json()).status, 'Visitors welcome');

    // Changing the signing key cannot restore a previous YES decision.
    await writeFile(secretFile, 'b'.repeat(64));
    const rotated = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(rotated.status, 'Absolutely not');
    assert.equal(rotated.connected, false);
    await writeFile(secretFile, token);
    assert.equal((await (await fetch(app.origin + '/api/status')).json()).status, 'Absolutely not',
      'rotating a token back must not revive an old approval');
    await writeFile(secretFile, 'b'.repeat(64));
    assert.equal((await post(app.origin, { status: 'Ask first' })).status, 401);
    assert.equal((await post(app.origin, { status: 'Ask first' }, 'b'.repeat(64))).status, 200);

    await unlink(secretFile);
    const unavailable = await (await fetch(app.origin + '/api/status')).json();
    assert.equal(unavailable.status, 'Absolutely not');
    assert.equal(unavailable.connected, false);
    assert.equal((await fetch(app.origin + '/healthz')).status, 200);
    assert.equal((await post(app.origin, { status: 'Ask first' })).status, 503);

    await writeFile(secretFile, token);
    assert.equal((await post(app.origin, { status: 'Ask first' })).status, 200);
    assert.equal((await (await fetch(app.origin + '/api/status')).json()).status, 'Ask first');
  } finally {
    await stop(app);
    await rm(dir, { recursive: true, force: true });
  }
});
