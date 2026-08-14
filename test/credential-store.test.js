import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CredentialStore } from '../src/credential-store.js';

const reverse = async (buffer) => Buffer.from(buffer).reverse();

test('CredentialStore lưu dữ liệu đã bảo vệ và tải lại credential', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'polygon-credentials-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'credentials.dat');
  const store = new CredentialStore({ filePath, protect: reverse, unprotect: reverse });

  assert.equal(await store.hasSaved(), false);
  await store.save({ apiKey: 'unit-api-key', secretKey: 'unit-secret-key' });
  assert.equal(await store.hasSaved(), true);

  const raw = await readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, /unit-api-key|unit-secret-key/);
  assert.deepEqual(await store.load(), {
    apiKey: 'unit-api-key',
    secretKey: 'unit-secret-key',
  });

  await store.save({ apiKey: 'updated-key', secretKey: 'updated-secret' });
  assert.deepEqual(await store.load(), { apiKey: 'updated-key', secretKey: 'updated-secret' });

  await store.clear();
  assert.equal(await store.hasSaved(), false);
  assert.equal(await store.load(), null);
});

test('CredentialStore không nhận credential trống', async () => {
  const store = new CredentialStore({ protect: reverse, unprotect: reverse });
  await assert.rejects(() => store.save({ apiKey: '', secretKey: '' }), /bắt buộc/);
});
