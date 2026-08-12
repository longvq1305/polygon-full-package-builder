import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignedParameters, PolygonApiError, PolygonClient } from '../src/polygon-client.js';

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
