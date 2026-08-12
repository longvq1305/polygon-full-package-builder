import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { JobManager } from './job-manager.js';
import { PolygonClient, PolygonApiError } from './polygon-client.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const SESSION_TTL_MS = 15 * 60 * 1_000;
const BODY_LIMIT_BYTES = 32 * 1024;

const sessions = new Map();
const jobManager = new JobManager();

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, statusCode, data) {
  const body = JSON.stringify(data);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new Error('Dữ liệu gửi lên quá lớn.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON không hợp lệ.');
  }
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    session.client.destroy();
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

async function createSession(request, response) {
  const { apiKey, secretKey } = await readJson(request);
  if (typeof apiKey !== 'string' || typeof secretKey !== 'string' || !apiKey.trim() || !secretKey.trim()) {
    sendError(response, 400, 'Vui lòng nhập đầy đủ API key và secret key.');
    return;
  }

  const client = new PolygonClient({ apiKey, secretKey });
  let problems;
  try {
    problems = await client.listProblems();
  } catch (error) {
    client.destroy();
    throw error;
  }
  const ownedProblems = problems
    .filter((problem) => problem.accessType === 'OWNER' && !problem.deleted)
    .sort((left, right) => left.name.localeCompare(right.name, 'vi'));
  const id = randomUUID();
  sessions.set(id, {
    client,
    problems: ownedProblems,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  sendJson(response, 201, {
    sessionId: id,
    expiresInSeconds: SESSION_TTL_MS / 1_000,
    problems: ownedProblems.map(({ id: problemId, name, owner, revision, workingCopyRevision, latestPackage, modified }) => ({
      id: problemId,
      name,
      owner,
      revision,
      workingCopyRevision,
      latestPackage,
      modified: Boolean(modified),
    })),
  });
}

async function createBuildJob(request, response, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    sendError(response, 401, 'Phiên đã hết hạn. Vui lòng nhập lại API key và secret key.');
    return;
  }

  const { problemIds, verify = false, concurrency = 2 } = await readJson(request);
  if (!Array.isArray(problemIds) || problemIds.length === 0) {
    sendError(response, 400, 'Hãy chọn ít nhất một problem.');
    return;
  }

  const selectedIds = new Set(problemIds.map(String));
  const selectedProblems = session.problems.filter((problem) => selectedIds.has(String(problem.id)));
  if (selectedProblems.length !== selectedIds.size) {
    sendError(response, 403, 'Danh sách có problem không thuộc quyền OWNER của phiên này.');
    return;
  }

  sessions.delete(sessionId);
  const job = jobManager.createJob({
    client: session.client,
    problems: selectedProblems,
    verify: Boolean(verify),
    concurrency,
  });
  sendJson(response, 202, job);
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(response, 403, 'Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'content-length': fileStat.size,
      'cache-control': pathname === '/' ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    const notFound = await readFile(join(PUBLIC_DIR, 'index.html'));
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': notFound.length });
    response.end(notFound);
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const path = url.pathname;

  try {
    if (request.method === 'GET' && path === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions') {
      await createSession(request, response);
      return;
    }

    const buildMatch = path.match(/^\/api\/sessions\/([^/]+)\/build$/);
    if (request.method === 'POST' && buildMatch) {
      await createBuildJob(request, response, buildMatch[1]);
      return;
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === 'DELETE' && sessionMatch) {
      const session = sessions.get(sessionMatch[1]);
      if (session) {
        session.client.destroy();
        sessions.delete(sessionMatch[1]);
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === 'GET') {
      const job = jobManager.getJob(jobMatch[1]);
      if (!job) sendError(response, 404, 'Không tìm thấy job.');
      else sendJson(response, 200, job);
      return;
    }
    if (jobMatch && request.method === 'DELETE') {
      const cancelled = jobManager.cancelJob(jobMatch[1]);
      if (!cancelled) sendError(response, 409, 'Job không tồn tại hoặc đã hoàn tất.');
      else sendJson(response, 202, { ok: true });
      return;
    }

    if (path.startsWith('/api/')) {
      sendError(response, 404, 'API endpoint không tồn tại.');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendError(response, 405, 'Method not allowed');
      return;
    }
    await serveStatic(path, response);
  } catch (error) {
    const statusCode = error instanceof PolygonApiError ? 502 : 400;
    sendError(response, statusCode, error instanceof Error ? error.message : 'Có lỗi không xác định.');
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      session.client.destroy();
      sessions.delete(id);
    }
  }
}, 60_000);
cleanupTimer.unref();

export const server = createServer(handleRequest);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`Polygon Full Package Builder đang chạy tại http://${HOST}:${PORT}`);
  });
}
