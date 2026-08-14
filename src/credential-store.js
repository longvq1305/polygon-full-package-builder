import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const DPAPI_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$plain=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($encrypted))',
].join(';');

const DPAPI_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$encrypted=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join(';');

function defaultCredentialPath() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'PolygonFullPackageBuilder', 'credentials.dat');
}

function runDpapi(script, input) {
  if (process.platform !== 'win32') {
    throw new Error('Lưu khóa an toàn hiện chỉ được hỗ trợ trên Windows.');
  }

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Windows không thể mã hóa credential (${errorOutput.trim() || `exit ${code}`}).`));
        return;
      }
      try {
        resolve(Buffer.from(output.trim(), 'base64'));
      } catch (error) {
        reject(new Error('Windows trả về credential đã mã hóa không hợp lệ.', { cause: error }));
      }
    });
    child.stdin.end(input.toString('base64'));
  });
}

const protectCurrentUser = (plain) => runDpapi(DPAPI_PROTECT_SCRIPT, plain);
const unprotectCurrentUser = (encrypted) => runDpapi(DPAPI_UNPROTECT_SCRIPT, encrypted);

export class CredentialStore {
  constructor({
    filePath = defaultCredentialPath(),
    protect = protectCurrentUser,
    unprotect = unprotectCurrentUser,
  } = {}) {
    this.filePath = filePath;
    this.protect = protect;
    this.unprotect = unprotect;
  }

  async hasSaved() {
    try {
      await readFile(this.filePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async save({ apiKey, secretKey }) {
    if (!apiKey?.trim() || !secretKey?.trim()) {
      throw new TypeError('API key và secret key là bắt buộc.');
    }
    const plain = Buffer.from(JSON.stringify({
      version: 1,
      apiKey: apiKey.trim(),
      secretKey: secretKey.trim(),
    }), 'utf8');
    const encrypted = await this.protect(plain);
    const directory = dirname(this.filePath);
    const temporaryPath = join(directory, `credentials-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, encrypted, { flag: 'wx', mode: 0o600 });
      await rm(this.filePath, { force: true });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => {});
    } finally {
      plain.fill(0);
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async load() {
    let encrypted;
    try {
      encrypted = await readFile(this.filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const plain = await this.unprotect(encrypted);
    try {
      const parsed = JSON.parse(plain.toString('utf8'));
      if (parsed.version !== 1 || !parsed.apiKey || !parsed.secretKey) {
        throw new Error('Credential đã lưu không đúng định dạng.');
      }
      return { apiKey: String(parsed.apiKey), secretKey: String(parsed.secretKey) };
    } finally {
      plain.fill(0);
    }
  }

  async clear() {
    await rm(this.filePath, { force: true });
  }
}

export { defaultCredentialPath };
