import assert from 'node:assert/strict';
import test from 'node:test';
import { JobManager } from '../src/job-manager.js';

const problem = (id, name = `Problem ${id}`) => ({
  id,
  name,
  owner: 'owner',
  revision: 7,
  modified: false,
  accessType: 'OWNER',
});

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timeout in test');
}

test('JobManager build và poll đến READY', async () => {
  let destroyed = false;
  let packagePolls = 0;
  const client = {
    async buildFullPackage(problemId, options) {
      assert.equal(problemId, 10);
      assert.deepEqual(options, { verify: true });
      return { id: 99, state: 'PENDING', type: 'standard', comment: '' };
    },
    async listPackages() {
      packagePolls += 1;
      return [{ id: 99, state: packagePolls > 1 ? 'READY' : 'RUNNING', type: 'standard', comment: '' }];
    },
    destroy() { destroyed = true; },
  };
  const manager = new JobManager({ pollIntervalMs: 0, sleepImpl: async () => {} });
  const created = manager.createJob({ client, problems: [problem(10)], verify: true, concurrency: 1 });

  await waitUntil(() => manager.getJob(created.id).finishedAt !== null);
  const job = manager.getJob(created.id);
  assert.equal(job.state, 'COMPLETED');
  assert.equal(job.counts.ready, 1);
  assert.equal(job.items[0].packageId, 99);
  assert.equal(job.items[0].state, 'READY');
  assert.equal(destroyed, true);
});

test('JobManager cô lập lỗi theo từng problem', async () => {
  const client = {
    async buildFullPackage(problemId) {
      if (problemId === 1) throw new Error('Working copy has modifications');
      return { id: 202, state: 'READY', type: 'standard' };
    },
    async listPackages() { return []; },
    destroy() {},
  };
  const manager = new JobManager({ pollIntervalMs: 0, sleepImpl: async () => {} });
  const created = manager.createJob({ client, problems: [problem(1), problem(2)], concurrency: 2 });

  await waitUntil(() => manager.getJob(created.id).finishedAt !== null);
  const job = manager.getJob(created.id);
  assert.equal(job.state, 'COMPLETED_WITH_ERRORS');
  assert.equal(job.counts.failed, 1);
  assert.equal(job.counts.ready, 1);
  assert.match(job.items[0].error, /modifications/);
});

test('JobManager giới hạn concurrency trong khoảng 1..4', () => {
  const never = new Promise(() => {});
  const client = {
    buildFullPackage: () => never,
    listPackages: async () => [],
    destroy() {},
  };
  const manager = new JobManager();
  const job = manager.createJob({ client, problems: [problem(1)], concurrency: 99 });
  assert.equal(job.concurrency, 4);
});

test('JobManager tìm package mới khi buildPackage trả result null', async () => {
  let listCalls = 0;
  const client = {
    async buildFullPackage() { return null; },
    async listPackages() {
      listCalls += 1;
      if (listCalls === 1) return [];
      if (listCalls === 2) {
        return [{ id: 333, revision: 7, state: 'PENDING', type: 'standard', creationTimeSeconds: 20 }];
      }
      return [{ id: 333, revision: 7, state: 'READY', type: 'standard', creationTimeSeconds: 20 }];
    },
    destroy() {},
  };
  const manager = new JobManager({ pollIntervalMs: 0, sleepImpl: async () => {} });
  const created = manager.createJob({ client, problems: [problem(3)], concurrency: 1 });

  await waitUntil(() => manager.getJob(created.id).finishedAt !== null);
  const job = manager.getJob(created.id);
  assert.equal(job.state, 'COMPLETED');
  assert.equal(job.items[0].packageId, 333);
  assert.equal(job.items[0].state, 'READY');
});

test('JobManager coi full package đã tồn tại là SKIPPED thay vì lỗi', async () => {
  const existingPackage = {
    id: 444,
    revision: 7,
    state: 'READY',
    type: 'standard',
    creationTimeSeconds: 30,
  };
  const client = {
    async buildFullPackage() {
      throw new Error('problemId: There is already non-failed full package for this revision without verification.');
    },
    async listPackages() { return [existingPackage]; },
    destroy() {},
  };
  const manager = new JobManager({ pollIntervalMs: 0, sleepImpl: async () => {} });
  const created = manager.createJob({ client, problems: [problem(4)], concurrency: 1 });

  await waitUntil(() => manager.getJob(created.id).finishedAt !== null);
  const job = manager.getJob(created.id);
  assert.equal(job.state, 'COMPLETED');
  assert.equal(job.counts.ready, 1);
  assert.equal(job.counts.skipped, 1);
  assert.equal(job.items[0].state, 'SKIPPED');
  assert.equal(job.items[0].packageId, 444);
});

test('JobManager phát hiện package mới FAILED mà không chờ timeout', async () => {
  let listCalls = 0;
  const client = {
    async buildFullPackage() { return null; },
    async listPackages() {
      listCalls += 1;
      if (listCalls === 1) return [];
      return [{
        id: 555,
        revision: 7,
        state: 'FAILED',
        type: 'standard',
        comment: 'Checker is not set',
        creationTimeSeconds: 40,
      }];
    },
    destroy() {},
  };
  const manager = new JobManager({ pollIntervalMs: 0, sleepImpl: async () => {} });
  const created = manager.createJob({ client, problems: [problem(5)], concurrency: 1 });

  await waitUntil(() => manager.getJob(created.id).finishedAt !== null);
  const job = manager.getJob(created.id);
  assert.equal(job.state, 'COMPLETED_WITH_ERRORS');
  assert.equal(job.items[0].packageId, 555);
  assert.equal(job.items[0].state, 'FAILED');
  assert.equal(job.items[0].error, 'Checker is not set');
});
