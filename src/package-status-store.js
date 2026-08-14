import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PROFILES = 8;
const STORABLE_STATUSES = new Set(['UNBUILT', 'STANDARD', 'FULL']);

function emptyStore() {
  return { version: STORE_VERSION, profiles: {} };
}

function sameValue(left, right) {
  if (left === undefined || left === null) return right === undefined || right === null;
  return String(left) === String(right);
}

export function fingerprintCredentials(apiKey, secretKey) {
  const normalizedApiKey = String(apiKey || '').trim();
  const normalizedSecretKey = String(secretKey || '').trim();
  if (!normalizedApiKey || !normalizedSecretKey) {
    throw new TypeError('API key và secret key là bắt buộc để tạo mã nhận diện.');
  }
  return createHash('sha256')
    .update('polygon-package-status-store-v1\0', 'utf8')
    .update(`${normalizedApiKey.length}:`, 'utf8')
    .update(normalizedApiKey, 'utf8')
    .update(`${normalizedSecretKey.length}:`, 'utf8')
    .update(normalizedSecretKey, 'utf8')
    .digest('hex');
}

export function defaultPackageStatusStorePath() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'PolygonFullPackageBuilder', 'package-status.json');
}

export class PackageStatusStore {
  constructor({
    filePath = defaultPackageStatusStorePath(),
    ttlMs = DEFAULT_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.filePath = filePath;
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.now = now;
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async getStatuses(profileKey, problems) {
    await this.#load();
    const now = this.now();
    const profile = this.data.profiles[profileKey] || { lastUsedAt: now, problems: {} };
    profile.lastUsedAt = now;
    this.data.profiles[profileKey] = profile;

    const statuses = new Map();
    for (const problem of problems) {
      const stored = profile.problems[String(problem.id)];
      if (!stored || !STORABLE_STATUSES.has(stored.status)) continue;
      const permanentFull = stored.status === 'FULL';
      const fresh = now - Number(stored.checkedAt) <= this.ttlMs;
      const samePackageRevision = sameValue(stored.latestPackage, problem.latestPackage);
      if (permanentFull || (fresh && samePackageRevision)) {
        statuses.set(String(problem.id), stored.status);
      }
    }

    this.#pruneProfiles();
    await this.#queuePersist();
    return statuses;
  }

  async setStatus(profileKey, problem, status) {
    if (!STORABLE_STATUSES.has(status)) return;
    await this.#load();
    const now = this.now();
    const profile = this.data.profiles[profileKey] || { lastUsedAt: now, problems: {} };
    profile.lastUsedAt = now;
    profile.problems[String(problem.id)] = {
      name: problem.name ?? null,
      revision: problem.revision ?? null,
      status,
      checkedAt: now,
      latestPackage: problem.latestPackage ?? null,
    };
    this.data.profiles[profileKey] = profile;
    this.#pruneProfiles();
    await this.#queuePersist();
  }

  async resetProfile(profileKey) {
    await this.#load();
    this.data.profiles[profileKey] = { lastUsedAt: this.now(), problems: {} };
    this.#pruneProfiles();
    await this.#queuePersist();
  }

  async #load() {
    if (this.data) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.data = parsed?.version === STORE_VERSION && parsed.profiles && typeof parsed.profiles === 'object'
        ? parsed
        : emptyStore();
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      this.data = emptyStore();
    }
  }

  #pruneProfiles() {
    const profiles = Object.entries(this.data.profiles);
    if (profiles.length <= MAX_PROFILES) return;
    profiles
      .sort(([, left], [, right]) => Number(right.lastUsedAt) - Number(left.lastUsedAt))
      .slice(MAX_PROFILES)
      .forEach(([profileKey]) => { delete this.data.profiles[profileKey]; });
  }

  #queuePersist() {
    const persist = this.writeQueue.then(() => this.#persist());
    this.writeQueue = persist.catch(() => {});
    return persist;
  }

  async #persist() {
    const directory = dirname(this.filePath);
    const temporaryPath = join(directory, `package-status-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rm(this.filePath, { force: true });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => {});
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
