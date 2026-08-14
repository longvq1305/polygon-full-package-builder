import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  fingerprintCredentials,
  PackageStatusStore,
} from '../src/package-status-store.js';

test('tạo một file JSON nhỏ và tách dữ liệu theo fingerprint credential', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'polygon-package-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'package-status.json');
  const firstProfile = fingerprintCredentials('api-key-a', 'secret-a');
  const secondProfile = fingerprintCredentials('api-key-b', 'secret-b');
  assert.equal(firstProfile, fingerprintCredentials('api-key-a', 'secret-a'));
  assert.notEqual(firstProfile, secondProfile);

  const store = new PackageStatusStore({ filePath, now: () => 10_000 });
  await store.getStatuses(firstProfile, []);
  await store.setStatus(firstProfile, { id: 1, latestPackage: 7 }, 'FULL');
  await store.setStatus(secondProfile, { id: 1, latestPackage: 7 }, 'STANDARD');

  const raw = await readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  assert.equal(data.version, 1);
  assert.equal(data.profiles[firstProfile].problems['1'].status, 'FULL');
  assert.equal(data.profiles[secondProfile].problems['1'].status, 'STANDARD');
  assert.doesNotMatch(raw, /api-key-a|secret-a|api-key-b|secret-b/);
});

test('FULL được nhớ lâu dài, STANDARD được quét lại khi hết hạn hoặc đổi package', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'polygon-package-store-ttl-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'package-status.json');
  const profile = fingerprintCredentials('api-key', 'secret-key');
  let clock = 1_000;
  const store = new PackageStatusStore({ filePath, ttlMs: 500, now: () => clock });
  await store.setStatus(profile, {
    id: 1,
    name: 'Problem đã có full',
    revision: 8,
    latestPackage: 3,
  }, 'FULL');
  await store.setStatus(profile, { id: 2, latestPackage: 3 }, 'STANDARD');

  assert.equal((await store.getStatuses(profile, [{ id: 2, latestPackage: 4 }])).has('2'), false);
  clock = 2_000;
  const expired = await store.getStatuses(profile, [
    { id: 1, latestPackage: 99 },
    { id: 2, latestPackage: 3 },
  ]);
  assert.equal(expired.get('1'), 'FULL');
  assert.equal(expired.has('2'), false);

  const reopenedStore = new PackageStatusStore({ filePath, ttlMs: 500, now: () => 99_000 });
  const afterRestart = await reopenedStore.getStatuses(profile, [{ id: 1 }]);
  assert.equal(afterRestart.get('1'), 'FULL');

  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(raw.profiles[profile].problems['1'].name, 'Problem đã có full');
  assert.equal(raw.profiles[profile].problems['1'].revision, 8);

  await reopenedStore.resetProfile(profile);
  assert.equal((await reopenedStore.getStatuses(profile, [{ id: 1, latestPackage: 3 }])).size, 0);
});
