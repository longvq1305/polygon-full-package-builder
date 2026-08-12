import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://polygon.codeforces.com/api';
const DEFAULT_REQUEST_INTERVAL_MS = 1_100;
const DEFAULT_RATE_LIMIT_RETRIES = 6;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseRetryAfter(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export class PolygonApiError extends Error {
  constructor(message, { method, statusCode, cause } = {}) {
    super(message, { cause });
    this.name = 'PolygonApiError';
    this.method = method;
    this.statusCode = statusCode;
  }
}

function compareEntries([leftKey, leftValue], [rightKey, rightValue]) {
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function toEntries(params) {
  const entries = [];
  for (const [key, rawValue] of Object.entries(params)) {
    if (rawValue === undefined || rawValue === null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      entries.push([key, typeof value === 'boolean' ? String(value).toLowerCase() : String(value)]);
    }
  }
  return entries;
}

export function createSignedParameters({ apiKey, secretKey, method, params = {}, time, nonce }) {
  const entries = toEntries({ ...params, apiKey, time }).sort(compareEntries);
  const signatureQuery = entries.map(([key, value]) => `${key}=${value}`).join('&');
  const signatureBase = `${nonce}/${method}?${signatureQuery}#${secretKey}`;
  const digest = createHash('sha512').update(signatureBase, 'utf8').digest('hex');
  const body = new URLSearchParams(entries);
  body.set('apiSig', `${nonce}${digest}`);
  return body;
}

export class PolygonClient {
  constructor({
    apiKey,
    secretKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    nonce = () => randomBytes(3).toString('hex'),
    timeoutMs = 30_000,
    requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
    maxRateLimitRetries = DEFAULT_RATE_LIMIT_RETRIES,
    sleepImpl = sleep,
  }) {
    if (!apiKey?.trim() || !secretKey?.trim()) {
      throw new TypeError('API key và secret key là bắt buộc.');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('Môi trường hiện tại không hỗ trợ fetch.');
    }

    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.nonce = nonce;
    this.timeoutMs = timeoutMs;
    this.requestIntervalMs = Math.max(0, Number(requestIntervalMs) || 0);
    this.maxRateLimitRetries = Math.max(0, Number(maxRateLimitRetries) || 0);
    this.sleep = sleepImpl;
    this.lastRequestAt = 0;
    this.rateLimitUntil = 0;
    this.requestQueue = Promise.resolve();
  }

  destroy() {
    this.apiKey = '';
    this.secretKey = '';
  }

  async call(method, params = {}) {
    if (!this.apiKey || !this.secretKey) {
      throw new PolygonApiError('Phiên xác thực đã hết hạn.', { method });
    }

    let response;
    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt += 1) {
      response = await this.#enqueueRequest(() => this.#fetch(method, params));
      if (response.status !== 429) break;

      if (attempt === this.maxRateLimitRetries) {
        throw new PolygonApiError(
          'Polygon vẫn đang giới hạn tần suất request. Tool đã tự chờ và thử lại nhưng chưa được; hãy chạy lại sau vài phút.',
          { method, statusCode: 429 },
        );
      }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());
      const exponentialBackoffMs = Math.min(60_000, 2_000 * (2 ** attempt));
      this.rateLimitUntil = Math.max(
        this.rateLimitUntil,
        this.now() + (retryAfterMs ?? exponentialBackoffMs),
      );
      await response.body?.cancel().catch(() => {});
    }

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new PolygonApiError(
        `Polygon trả về dữ liệu không hợp lệ (HTTP ${response.status}).`,
        { method, statusCode: response.status, cause: error },
      );
    }

    if (!response.ok || payload.status !== 'OK') {
      throw new PolygonApiError(
        payload.comment || `Yêu cầu Polygon thất bại (HTTP ${response.status}).`,
        { method, statusCode: response.status },
      );
    }

    return payload.result;
  }

  #enqueueRequest(action) {
    const request = this.requestQueue.then(async () => {
      const earliestRequestAt = Math.max(
        this.rateLimitUntil,
        this.lastRequestAt + this.requestIntervalMs,
      );
      const delayMs = Math.max(0, earliestRequestAt - this.now());
      if (delayMs > 0) await this.sleep(delayMs);
      this.lastRequestAt = this.now();
      return action();
    });
    this.requestQueue = request.catch(() => {});
    return request;
  }

  async #fetch(method, params) {
    const time = Math.floor(this.now() / 1000);
    const body = createSignedParameters({
      apiKey: this.apiKey,
      secretKey: this.secretKey,
      method,
      params,
      time,
      nonce: this.nonce(),
    });

    try {
      return await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error?.name === 'TimeoutError'
        ? `Polygon không phản hồi trong ${Math.round(this.timeoutMs / 1000)} giây.`
        : 'Không thể kết nối tới Polygon.';
      throw new PolygonApiError(message, { method, cause: error });
    }
  }

  listProblems() {
    return this.call('problems.list', { showDeleted: false });
  }

  buildFullPackage(problemId, { verify = false } = {}) {
    return this.call('problem.buildPackage', {
      problemId,
      full: true,
      verify,
    });
  }

  listPackages(problemId) {
    return this.call('problem.packages', { problemId });
  }
}
