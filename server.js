import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const dataFile = process.env.DATA_FILE || '/data/status.json';
const demo = process.env.DEMO_MODE === 'true';
const port = Number(process.env.PORT || 3000);
const VALID_STATUSES = new Set(['Absolutely not', 'Ask first', 'Visitors welcome']);
const DEFAULT_STATUS = 'Absolutely not';
// HA sends a heartbeat every minute. Without one, fail closed.
const statusTtlSeconds = Number(process.env.STATUS_TTL_SECONDS || 180);
if (!Number.isFinite(statusTtlSeconds) || statusTtlSeconds <= 0) {
  throw new Error('STATUS_TTL_SECONDS must be a positive number.');
}
const statusTtlMs = statusTtlSeconds * 1000;

const DEMO_STATUSES = Object.freeze({ no: 'Absolutely not', ask: 'Ask first', yes: 'Visitors welcome' });
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

async function getToken() {
  if (demo) return null;
  const file = process.env.UPDATE_TOKEN_FILE;
  const token = file ? (await readFile(file, 'utf8')).trim() : process.env.UPDATE_TOKEN;
  if (!token || token.length < 32) {
    throw new Error('Production requires UPDATE_TOKEN or UPDATE_TOKEN_FILE (minimum 32 characters).');
  }
  return token;
}

function matchesToken(provided, expected) {
  if (typeof provided !== 'string' || !provided.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(provided.slice(7), 'utf8');
  const valid = Buffer.from(expected, 'utf8');
  return candidate.length === valid.length && timingSafeEqual(candidate, valid);
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

async function loadStatus() {
  try {
    const loaded = JSON.parse(await readFile(dataFile, 'utf8'));
    if (VALID_STATUSES.has(loaded.status) && Number.isFinite(Date.parse(loaded.updatedAt)) &&
        Number.isFinite(Date.parse(loaded.lastSeenAt))) return loaded;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Unable to load saved visitor status:', err.message);
  }
  return { status: DEFAULT_STATUS, updatedAt: null, lastSeenAt: null };
}

async function saveStatus(state) {
  await mkdir(resolve(dataFile, '..'), { recursive: true });
  const temporary = `${dataFile}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, dataFile);
  } catch (error) {
    try { const { unlink } = await import('node:fs/promises'); await unlink(temporary); } catch {}
    throw error;
  }
}

async function readBody(req, maxBytes = 4096) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Payload too large'), { httpStatus: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const token = await getToken();
  let current = demo
    ? { status: DEFAULT_STATUS, updatedAt: null, lastSeenAt: null }
    : await loadStatus();
  let pendingSave = Promise.resolve();

  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    let pathname;
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Bad URL' });
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      const example = demo ? DEMO_STATUSES[url.searchParams.get('demo')] : undefined;
      const lastSeenMs = Date.parse(current.lastSeenAt);
      const connected = demo || (Number.isFinite(lastSeenMs) &&
        lastSeenMs <= Date.now() && Date.now() - lastSeenMs < statusTtlMs);
      return sendJson(res, 200, {
        status: example || (connected ? current.status : DEFAULT_STATUS),
        updatedAt: connected && !example ? current.updatedAt : null,
        connected: demo ? false : connected,
        demo,
      });
    }

    if (pathname === '/api/ha-update') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      if (demo) return sendJson(res, 403, { error: 'Updates disabled in demo mode' });
      if (!matchesToken(req.headers.authorization, token)) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Expected application/json' });
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (err) {
        return sendJson(res, err.httpStatus || 400, { error: err.httpStatus ? 'Payload too large' : 'Invalid JSON' });
      }
      if (!payload || !VALID_STATUSES.has(payload.status)) {
        return sendJson(res, 400, { error: 'Unknown status' });
      }
      // Serialize writes: concurrent updates must finish in arrival order.
      const now = new Date().toISOString();
      const nextState = {
        status: payload.status,
        // A heartbeat must not change the time of the last actual decision.
        updatedAt: payload.status === current.status && current.updatedAt ? current.updatedAt : now,
        lastSeenAt: now,
      };
      pendingSave = pendingSave.catch(() => {}).then(() => saveStatus(nextState).then(() => { current = nextState; }));
      try {
        await pendingSave;
        return sendJson(res, 200, { ok: true, ...current });
      } catch (error) {
        console.error('Failed to persist status:', error.message);
        return sendJson(res, 500, { error: 'Could not save status' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    const filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const target = resolve(root, filePath);
    const allowed = target.startsWith(resolve(root) + sep) && !filePath.startsWith('.');
    if (!allowed) return sendJson(res, 404, { error: 'Not found' });
    const type = types[extname(target)];
    if (!type) return sendJson(res, 404, { error: 'Not found' });
    try {
      const { stat } = await import('node:fs/promises');
      const info = await stat(target);
      if (!info.isFile()) throw new Error('Not a file');
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        'Cache-Control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(target).pipe(res);
    } catch {
      if (!res.headersSent) sendJson(res, 404, { error: 'Not found' });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`May I Come? listening on port ${port} (${demo ? 'demo' : 'Home Assistant push'} mode)`);
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
