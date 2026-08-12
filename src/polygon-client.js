import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://polygon.codeforces.com/api';

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
  }

  destroy() {
    this.apiKey = '';
    this.secretKey = '';
  }

  async call(method, params = {}) {
    if (!this.apiKey || !this.secretKey) {
      throw new PolygonApiError('Phiên xác thực đã hết hạn.', { method });
    }

    const time = Math.floor(this.now() / 1000);
    const body = createSignedParameters({
      apiKey: this.apiKey,
      secretKey: this.secretKey,
      method,
      params,
      time,
      nonce: this.nonce(),
    });

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
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
