import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { JobManager } from './job-manager.js';
import { PolygonClient, PolygonApiError, PolygonRequestScheduler } from './polygon-client.js';
import { CredentialStore } from './credential-store.js';
import {
  fingerprintCredentials,
  PackageStatusStore,
} from './package-status-store.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const BODY_LIMIT_BYTES = 32 * 1024;
const APP_VERSION = '1.2.0';
const APP_CAPABILITIES = ['full-package-history-filter-v1', 'local-package-status-store-v1'];

const sessions = new Map();
const jobManager = new JobManager();
const credentialStore = new CredentialStore();
const packageStatusStore = new PackageStatusStore();
const polygonRequestScheduler = new PolygonRequestScheduler();
const TERMINAL_JOB_STATES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED']);

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
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function initialPackageStatus(problem, storedStatuses) {
  if (problem.latestPackage === undefined || problem.latestPackage === null) return 'UNBUILT';
  return storedStatuses.get(String(problem.id)) || 'LOADING';
}

function publicSessionProblem(session, problem) {
  const problemId = String(problem.id);
  return {
    id: problem.id,
    name: problem.name,
    owner: problem.owner,
    revision: problem.revision,
    workingCopyRevision: problem.workingCopyRevision,
    latestPackage: problem.latestPackage,
    packageStatus: session.packageStatuses.get(problemId) || 'UNBUILT',
    packageStatusStored: session.storedPackageStatusIds.has(problemId),
    modified: Boolean(problem.modified),
  };
}

async function openSession({ apiKey, secretKey, remember = false }, response) {
  if (typeof apiKey !== 'string' || typeof secretKey !== 'string' || !apiKey.trim() || !secretKey.trim()) {
    sendError(response, 400, 'Vui lòng nhập đầy đủ API key và secret key.');
    return;
  }

  const client = new PolygonClient({ apiKey, secretKey, requestScheduler: polygonRequestScheduler });
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
  const statusProfileKey = fingerprintCredentials(apiKey, secretKey);
  const storedStatuses = await packageStatusStore.getStatuses(statusProfileKey, ownedProblems);
  const id = randomUUID();
  if (remember) await credentialStore.save({ apiKey, secretKey });
  sessions.set(id, {
    client,
    problems: ownedProblems,
    statusProfileKey,
    packageStatuses: new Map(ownedProblems.map((problem) => [
      String(problem.id),
      initialPackageStatus(problem, storedStatuses),
    ])),
    storedPackageStatusIds: new Set(storedStatuses.keys()),
    expiresAt: Date.now() + SESSION_TTL_MS,
    activeJobId: null,
  });

  sendJson(response, 201, {
    sessionId: id,
    expiresInSeconds: SESSION_TTL_MS / 1_000,
    credentialsSaved: await credentialStore.hasSaved(),
    packageStatusStoreHits: storedStatuses.size,
    problems: ownedProblems.map((problem) => publicSessionProblem(sessions.get(id), problem)),
  });
}

async function createSession(request, response) {
  const { apiKey, secretKey, remember = false } = await readJson(request);
  await openSession({ apiKey, secretKey, remember: Boolean(remember) }, response);
}

async function createSavedSession(response) {
  const credentials = await credentialStore.load();
  if (!credentials) {
    sendError(response, 404, 'Chưa có API key/secret key được lưu trên máy.');
    return;
  }
  try {
    await openSession({ ...credentials, remember: false }, response);
  } finally {
    credentials.apiKey = '';
    credentials.secretKey = '';
  }
}

export function classifyPackageStatus(problem, packages) {
  if (problem.latestPackage === undefined || problem.latestPackage === null) return 'UNBUILT';

  const readyPackages = packages.filter((packageInfo) => packageInfo.state === 'READY');
  if (readyPackages.length === 0) return 'UNBUILT';

  if (readyPackages.some((packageInfo) => {
    return ['linux', 'windows', 'full'].includes(String(packageInfo.type).toLowerCase());
  })) {
    return 'FULL';
  }
  if (readyPackages.some((packageInfo) => String(packageInfo.type).toLowerCase() === 'standard')) {
    return 'STANDARD';
  }
  return 'UNBUILT';
}

async function getProblemPackageStatus(response, sessionId, problemId) {
  const session = getSession(sessionId);
  if (!session) {
    sendError(response, 401, 'Phiên đã hết hạn. Vui lòng kết nối lại.');
    return;
  }

  const problem = session.problems.find((candidate) => String(candidate.id) === String(problemId));
  if (!problem) {
    sendError(response, 404, 'Không tìm thấy problem thuộc quyền OWNER trong phiên này.');
    return;
  }
  const currentStatus = session.packageStatuses.get(String(problem.id));
  if (currentStatus && currentStatus !== 'LOADING') {
    sendJson(response, 200, {
      problemId: problem.id,
      status: currentStatus,
      stored: session.storedPackageStatusIds.has(String(problem.id)),
    });
    return;
  }
  if (problem.latestPackage === undefined || problem.latestPackage === null) {
    sendJson(response, 200, { problemId: problem.id, status: 'UNBUILT' });
    return;
  }

  const packages = await session.client.listPackages(problem.id);
  const status = classifyPackageStatus(problem, packages);
  await packageStatusStore.setStatus(session.statusProfileKey, problem, status);
  session.packageStatuses.set(String(problem.id), status);
  session.storedPackageStatusIds.add(String(problem.id));
  sendJson(response, 200, {
    problemId: problem.id,
    status,
    stored: false,
  });
}

async function refreshStoredPackageStatuses(response, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    sendError(response, 401, 'Phiên đã hết hạn. Vui lòng kết nối lại.');
    return;
  }
  const activeJob = session.activeJobId ? jobManager.getJob(session.activeJobId) : null;
  if (activeJob && !TERMINAL_JOB_STATES.has(activeJob.state)) {
    sendError(response, 409, 'Không thể quét lại trạng thái khi job đang chạy.');
    return;
  }

  await packageStatusStore.resetProfile(session.statusProfileKey);
  session.storedPackageStatusIds.clear();
  for (const problem of session.problems) {
    session.packageStatuses.set(
      String(problem.id),
      problem.latestPackage === undefined || problem.latestPackage === null ? 'UNBUILT' : 'LOADING',
    );
  }
  sendJson(response, 200, {
    packageStatusStoreHits: 0,
    problems: session.problems.map((problem) => publicSessionProblem(session, problem)),
  });
}

async function createBuildJob(request, response, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    sendError(response, 401, 'Phiên đã hết hạn. Vui lòng nhập lại API key và secret key.');
    return;
  }

  if (session.activeJobId) {
    const activeJob = jobManager.getJob(session.activeJobId);
    if (activeJob && !TERMINAL_JOB_STATES.has(activeJob.state)) {
      sendError(response, 409, 'Một job khác đang chạy. Hãy chờ job đó hoàn tất hoặc dừng theo dõi.');
      return;
    }
    session.activeJobId = null;
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
  if (selectedProblems.some((problem) => problem.modified)) {
    sendError(response, 409, 'Có problem chưa commit thay đổi. Hãy commit trên Polygon rồi kết nối lại.');
    return;
  }

  const job = jobManager.createJob({
    client: session.client,
    problems: selectedProblems,
    verify: Boolean(verify),
    concurrency,
    destroyClientOnFinish: false,
    onFinished: async (finishedJob) => {
      for (const item of finishedJob.items) {
        if (item.state !== 'READY' && item.state !== 'SKIPPED') continue;
        const problem = session.problems.find((candidate) => String(candidate.id) === String(item.problem.id));
        if (!problem) continue;
        problem.latestPackage = problem.revision;
        session.packageStatuses.set(String(problem.id), 'FULL');
        session.storedPackageStatusIds.add(String(problem.id));
        await packageStatusStore.setStatus(session.statusProfileKey, problem, 'FULL');
      }
    },
  });
  session.activeJobId = job.id;
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
      'cache-control': 'no-store',
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
      sendJson(response, 200, {
        ok: true,
        version: APP_VERSION,
        capabilities: APP_CAPABILITIES,
      });
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions') {
      await createSession(request, response);
      return;
    }
    if (request.method === 'POST' && path === '/api/sessions/saved') {
      await createSavedSession(response);
      return;
    }
    if (request.method === 'GET' && path === '/api/credentials/status') {
      sendJson(response, 200, { saved: await credentialStore.hasSaved() });
      return;
    }
    if (request.method === 'DELETE' && path === '/api/credentials') {
      await credentialStore.clear();
      sendJson(response, 200, { ok: true });
      return;
    }

    const buildMatch = path.match(/^\/api\/sessions\/([^/]+)\/build$/);
    if (request.method === 'POST' && buildMatch) {
      await createBuildJob(request, response, buildMatch[1]);
      return;
    }

    const packageStatusMatch = path.match(/^\/api\/sessions\/([^/]+)\/problems\/([^/]+)\/package-status$/);
    if (request.method === 'GET' && packageStatusMatch) {
      await getProblemPackageStatus(response, packageStatusMatch[1], packageStatusMatch[2]);
      return;
    }

    const packageStatusRefreshMatch = path.match(/^\/api\/sessions\/([^/]+)\/package-status-store\/refresh$/);
    if (request.method === 'POST' && packageStatusRefreshMatch) {
      await refreshStoredPackageStatuses(response, packageStatusRefreshMatch[1]);
      return;
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === 'DELETE' && sessionMatch) {
      const session = sessions.get(sessionMatch[1]);
      if (session) {
        const activeJob = session.activeJobId ? jobManager.getJob(session.activeJobId) : null;
        if (activeJob && !TERMINAL_JOB_STATES.has(activeJob.state)) {
          sendError(response, 409, 'Không thể đóng phiên khi job đang chạy.');
          return;
        }
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
    const statusCode = error instanceof PolygonApiError
      ? (error.statusCode === 429 ? 429 : 502)
      : 400;
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
