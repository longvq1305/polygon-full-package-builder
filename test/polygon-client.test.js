import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSignedParameters,
  PolygonApiError,
  PolygonClient,
  PolygonRequestScheduler,
} from '../src/polygon-client.js';

test('createSignedParameters sắp xếp tham số và tạo chữ ký ổn định', () => {
  const body = createSignedParameters({
    apiKey: 'demo-key',
    secretKey: 'demo-secret',
    method: 'problem.buildPackage',
    params: { verify: false, problemId: 42, full: true },
    time: 1_700_000_000,
    nonce: 'abc123',
  });

  assert.equal(body.get('apiKey'), 'demo-key');
  assert.equal(body.get('full'), 'true');
  assert.equal(body.get('problemId'), '42');
  assert.equal(body.get('time'), '1700000000');
  assert.equal(body.get('verify'), 'false');
  assert.equal(
    body.get('apiSig'),
    'abc123d13ce485786a5c2549c0eab2d6490732b45a6018ba352ede684968c9ee6b274faf9103e8bf1a7563a5f4956f36de89e03c77c147fd5495afaae4065aa88d0e3d',
  );
});

test('PolygonClient gửi POST form và đọc result', async () => {
  let captured;
  const client = new PolygonClient({
    apiKey: 'key',
    secretKey: 'secret',
    now: () => 1_700_000_000_000,
    nonce: () => '123456',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ status: 'OK', result: [{ id: 1, accessType: 'OWNER' }] }));
    },
  });

  const result = await client.listProblems();
  assert.deepEqual(result, [{ id: 1, accessType: 'OWNER' }]);
  assert.equal(captured.url, 'https://polygon.codeforces.com/api/problems.list');
  assert.equal(captured.options.method, 'POST');
  const requestBody = new URLSearchParams(captured.options.body);
  assert.equal(requestBody.get('showDeleted'), 'false');
  assert.equal(requestBody.get('apiKey'), 'key');
  assert.match(requestBody.get('apiSig'), /^123456[0-9a-f]{128}$/);
});

test('PolygonClient commit working copy với nội dung commit trống', async () => {
  let captured;
  const client = new PolygonClient({
    apiKey: 'key',
    secretKey: 'secret',
    now: () => 1_700_000_000_000,
    nonce: () => '654321',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        status: 'OK',
        result: { committed: true, conflictOccurred: false, message: '' },
      }));
    },
  });

  const result = await client.commitChanges(42);
  const requestBody = new URLSearchParams(captured.options.body);
  assert.equal(captured.url, 'https://polygon.codeforces.com/api/problem.commitChanges');
  assert.equal(requestBody.get('problemId'), '42');
  assert.equal(requestBody.get('message'), '');
  assert.equal(requestBody.get('minorChanges'), 'true');
  assert.equal(result.committed, true);
});

test('PolygonClient chuyển lỗi API thành PolygonApiError', async () => {
  const client = new PolygonClient({
    apiKey: 'key',
    secretKey: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ status: 'FAILED', comment: 'Invalid API key' })),
  });

  await assert.rejects(() => client.listProblems(), (error) => {
    assert.ok(error instanceof PolygonApiError);
    assert.equal(error.message, 'Invalid API key');
    assert.equal(error.method, 'problems.list');
    return true;
  });
});

test('destroy xóa credential khỏi client', async () => {
  const client = new PolygonClient({ apiKey: 'key', secretKey: 'secret' });
  client.destroy();
  assert.equal(client.apiKey, '');
  assert.equal(client.secretKey, '');
  await assert.rejects(() => client.listProblems(), /hết hạn/);
});

test('PolygonClient chờ Retry-After và tự thử lại HTTP 429 không phải JSON', async () => {
  let clock = 1_700_000_000_000;
  let calls = 0;
  const waits = [];
  const client = new PolygonClient({
    apiKey: 'key',
    secretKey: 'secret',
    now: () => clock,
    requestIntervalMs: 0,
    sleepImpl: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'retry-after': '30' },
        });
      }
      return new Response(JSON.stringify({ status: 'OK', result: ['recovered'] }));
    },
  });

  const result = await client.listProblems();
  assert.deepEqual(result, ['recovered']);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [30_000]);
});

test('PolygonClient trả thông báo rate limit rõ ràng sau khi hết retry', async () => {
  let clock = 1_700_000_000_000;
  let calls = 0;
  const client = new PolygonClient({
    apiKey: 'key',
    secretKey: 'secret',
    now: () => clock,
    requestIntervalMs: 0,
    maxRateLimitRetries: 2,
    sleepImpl: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async () => {
      calls += 1;
      return new Response('<html>rate limited</html>', { status: 429 });
    },
  });

  await assert.rejects(() => client.listProblems(), (error) => {
    assert.ok(error instanceof PolygonApiError);
    assert.equal(error.statusCode, 429);
    assert.match(error.message, /giới hạn tần suất/);
    return true;
  });
  assert.equal(calls, 3);
});

test('PolygonClient tuần tự hóa request đồng thời theo khoảng cách tối thiểu', async () => {
  let clock = 10_000;
  const requestTimes = [];
  const client = new PolygonClient({
    apiKey: 'key',
    secretKey: 'secret',
    now: () => clock,
    requestIntervalMs: 1_000,
    sleepImpl: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async () => {
      requestTimes.push(clock);
      return new Response(JSON.stringify({ status: 'OK', result: [] }));
    },
  });

  await Promise.all([client.listProblems(), client.listProblems()]);
  assert.deepEqual(requestTimes, [10_000, 11_000]);
});

test('nhiều PolygonClient dùng chung scheduler không gửi request song song', async () => {
  let clock = 50_000;
  const requestTimes = [];
  const scheduler = new PolygonRequestScheduler({
    requestIntervalMs: 2_000,
    now: () => clock,
    sleepImpl: async (milliseconds) => { clock += milliseconds; },
  });
  const fetchImpl = async () => {
    requestTimes.push(clock);
    return new Response(JSON.stringify({ status: 'OK', result: [] }));
  };
  const common = {
    apiKey: 'key',
    secretKey: 'secret',
    now: () => clock,
    requestScheduler: scheduler,
    fetchImpl,
  };
  const firstClient = new PolygonClient(common);
  const secondClient = new PolygonClient(common);

  await Promise.all([firstClient.listProblems(), secondClient.listProblems()]);
  assert.deepEqual(requestTimes, [50_000, 52_000]);
});
