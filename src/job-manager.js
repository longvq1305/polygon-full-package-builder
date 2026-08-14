import { randomUUID } from 'node:crypto';

const TERMINAL_PACKAGE_STATES = new Set(['READY', 'FAILED']);
const TERMINAL_ITEM_STATES = new Set(['READY', 'SKIPPED', 'FAILED', 'CANCELLED']);
const DUPLICATE_FULL_PACKAGE_PATTERN = /already non-failed full package/i;
const PACKAGE_DISCOVERY_TIMEOUT_MS = 2 * 60 * 1_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function publicProblem(problem) {
  return {
    id: problem.id,
    name: problem.name,
    owner: problem.owner,
    revision: problem.revision,
    modified: Boolean(problem.modified),
    latestPackage: problem.latestPackage,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class JobManager {
  constructor({
    pollIntervalMs = 30_000,
    packageTimeoutMs = 4 * 60 * 60 * 1_000,
    sleepImpl = sleep,
    now = () => Date.now(),
  } = {}) {
    this.jobs = new Map();
    this.pollIntervalMs = pollIntervalMs;
    this.packageTimeoutMs = packageTimeoutMs;
    this.sleep = sleepImpl;
    this.now = now;
  }

  createJob({ client, problems, verify = false, concurrency = 1, destroyClientOnFinish = true }) {
    const safeConcurrency = Math.max(1, Math.min(4, Number(concurrency) || 2));
    const id = randomUUID();
    const createdAt = new Date(this.now()).toISOString();
    const job = {
      id,
      state: 'RUNNING',
      verify: Boolean(verify),
      concurrency: safeConcurrency,
      createdAt,
      finishedAt: null,
      cancelRequested: false,
      client,
      destroyClientOnFinish,
      items: problems.map((problem) => ({
        problem: publicProblem(problem),
        state: 'QUEUED',
        packageId: null,
        packageType: null,
        packageComment: '',
        startedAt: null,
        finishedAt: null,
        error: null,
      })),
    };
    this.jobs.set(id, job);
    void this.#run(job);
    return this.toJSON(job);
  }

  getJob(id) {
    const job = this.jobs.get(id);
    return job ? this.toJSON(job) : null;
  }

  cancelJob(id) {
    const job = this.jobs.get(id);
    if (!job || job.finishedAt) return false;
    job.cancelRequested = true;
    for (const item of job.items) {
      if (item.state === 'QUEUED') {
        item.state = 'CANCELLED';
        item.finishedAt = new Date(this.now()).toISOString();
      }
    }
    return true;
  }

  toJSON(job) {
    const items = job.items.map((item) => ({
      ...item,
      problem: { ...item.problem },
    }));
    const counts = items.reduce((result, item) => {
      result.total += 1;
      if (TERMINAL_ITEM_STATES.has(item.state)) result.completed += 1;
      if (item.state === 'READY' || item.state === 'SKIPPED') result.ready += 1;
      if (item.state === 'SKIPPED') result.skipped += 1;
      if (item.state === 'FAILED') result.failed += 1;
      if (item.state === 'CANCELLED') result.cancelled += 1;
      return result;
    }, { total: 0, completed: 0, ready: 0, skipped: 0, failed: 0, cancelled: 0 });

    return {
      id: job.id,
      state: job.state,
      verify: job.verify,
      concurrency: job.concurrency,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      cancelRequested: job.cancelRequested,
      counts,
      items,
    };
  }

  async #run(job) {
    let cursor = 0;
    const nextItem = () => {
      if (job.cancelRequested) return null;
      while (cursor < job.items.length) {
        const item = job.items[cursor++];
        if (item.state === 'QUEUED') return item;
      }
      return null;
    };

    const workers = Array.from(
      { length: Math.min(job.concurrency, Math.max(job.items.length, 1)) },
      async () => {
        for (let item = nextItem(); item; item = nextItem()) {
          await this.#buildOne(job, item);
        }
      },
    );

    try {
      await Promise.all(workers);
    } finally {
      for (const item of job.items) {
        if (item.state === 'QUEUED') {
          item.state = 'CANCELLED';
          item.finishedAt = new Date(this.now()).toISOString();
        }
      }
      const hasFailure = job.items.some((item) => item.state === 'FAILED');
      const hasCancellation = job.items.some((item) => item.state === 'CANCELLED');
      job.state = hasFailure ? 'COMPLETED_WITH_ERRORS' : hasCancellation ? 'CANCELLED' : 'COMPLETED';
      job.finishedAt = new Date(this.now()).toISOString();
      if (job.destroyClientOnFinish) job.client.destroy();
      job.client = null;
    }
  }

  async #buildOne(job, item) {
    item.state = 'SUBMITTING';
    item.startedAt = new Date(this.now()).toISOString();

    try {
      const buildRequestedAtSeconds = Math.floor(this.now() / 1_000);
      let createdPackage;

      try {
        const buildResult = await job.client.buildFullPackage(item.problem.id, {
          verify: job.verify,
        });
        createdPackage = this.#normalizeBuildResult(buildResult);
      } catch (error) {
        if (!DUPLICATE_FULL_PACKAGE_PATTERN.test(errorMessage(error))) throw error;

        if (String(item.problem.latestPackage) === String(item.problem.revision)) {
          item.state = 'SKIPPED';
          item.packageComment = 'Polygon xác nhận revision này đã có full package; không tạo bản trùng.';
          return;
        }

        const packages = await job.client.listPackages(item.problem.id);
        const existingPackage = this.#latestUsablePackage(packages, item.problem.revision);
        if (!existingPackage) throw error;

        this.#applyPackage(item, existingPackage);
        if (existingPackage.state === 'READY') {
          item.state = 'SKIPPED';
          item.packageComment = 'Revision này đã có full package sẵn sàng; không tạo bản trùng.';
          return;
        }
        if (!TERMINAL_PACKAGE_STATES.has(existingPackage.state)) {
          await this.#waitForPackage(job, item);
        }
        if (item.state === 'FAILED' && !item.error) {
          item.error = item.packageComment || 'Polygon không build được package.';
        }
        return;
      }

      if (!createdPackage) {
        item.state = 'PENDING';
        createdPackage = await this.#discoverNewPackage(job, item, buildRequestedAtSeconds);
      }

      this.#applyPackage(item, createdPackage);

      if (!TERMINAL_PACKAGE_STATES.has(item.state)) {
        await this.#waitForPackage(job, item);
      }

      if (item.state === 'FAILED' && !item.error) {
        item.error = item.packageComment || 'Polygon không build được package.';
      }
    } catch (error) {
      item.state = 'FAILED';
      item.error = errorMessage(error);
    } finally {
      item.finishedAt = new Date(this.now()).toISOString();
    }
  }

  #normalizeBuildResult(buildResult) {
    if (buildResult && typeof buildResult === 'object' && buildResult.id !== undefined) {
      return buildResult;
    }
    if (typeof buildResult === 'number' || typeof buildResult === 'string') {
      return { id: buildResult, state: 'PENDING', type: 'standard', comment: '' };
    }
    return null;
  }

  #latestUsablePackage(packages, revision) {
    return this.#latestPackage(packages, revision, { includeFailed: false });
  }

  #latestPackage(packages, revision, { includeFailed = true } = {}) {
    return packages
      .filter((candidate) => {
        return String(candidate.revision) === String(revision)
          && (includeFailed || candidate.state !== 'FAILED');
      })
      .sort((left, right) => {
        return (Number(right.creationTimeSeconds) || 0) - (Number(left.creationTimeSeconds) || 0)
          || (Number(right.id) || 0) - (Number(left.id) || 0);
      })[0] || null;
  }

  #applyPackage(item, packageInfo) {
    item.packageId = packageInfo.id;
    item.packageType = packageInfo.type || 'standard';
    item.packageComment = packageInfo.comment || '';
    item.state = packageInfo.state || 'PENDING';
  }

  async #discoverNewPackage(job, item, buildRequestedAtSeconds) {
    const deadline = this.now() + Math.min(PACKAGE_DISCOVERY_TIMEOUT_MS, this.packageTimeoutMs);
    let consecutivePollErrors = 0;

    while (this.now() < deadline) {
      if (job.cancelRequested) {
        throw new Error('Đã dừng trước khi xác định được package mới trên Polygon.');
      }

      try {
        const packages = await job.client.listPackages(item.problem.id);
        consecutivePollErrors = 0;
        const recentPackages = packages.filter((candidate) => {
          return (Number(candidate.creationTimeSeconds) || 0) >= buildRequestedAtSeconds - 5;
        });
        const discovered = this.#latestPackage(recentPackages, item.problem.revision);
        if (discovered) return discovered;
      } catch (error) {
        consecutivePollErrors += 1;
        if (consecutivePollErrors >= 3) throw error;
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new Error('Polygon đã nhận lệnh build nhưng tool không tìm thấy package mới trong 2 phút.');
  }

  async #waitForPackage(job, item) {
    const deadline = this.now() + this.packageTimeoutMs;
    let consecutivePollErrors = 0;
    while (this.now() < deadline) {
      if (job.cancelRequested) {
        item.state = 'CANCELLED';
        item.error = 'Đã dừng theo dõi. Package đã gửi lên Polygon có thể vẫn tiếp tục build.';
        return;
      }

      await this.sleep(this.pollIntervalMs);
      let packages;
      try {
        packages = await job.client.listPackages(item.problem.id);
        consecutivePollErrors = 0;
      } catch (error) {
        consecutivePollErrors += 1;
        if (consecutivePollErrors >= 3) throw error;
        continue;
      }
      const current = packages.find((candidate) => String(candidate.id) === String(item.packageId));
      if (!current) continue;

      item.state = current.state;
      item.packageType = current.type || item.packageType;
      item.packageComment = current.comment || '';
      if (TERMINAL_PACKAGE_STATES.has(current.state)) return;
    }

    throw new Error('Hết thời gian chờ package hoàn tất. Hãy kiểm tra trực tiếp trên Polygon.');
  }
}
