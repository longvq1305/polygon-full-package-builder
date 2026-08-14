import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isEligibleProblem,
  supportsPackageHistoryFilter,
} from '../public/package-status.js';
import { classifyPackageStatus, resolveInitialPackageStatus } from '../src/server.js';

const problemWithPackage = { id: 1, latestPackage: 9 };

test('ẩn problem nếu lịch sử cũ từng có full package READY', () => {
  const packages = [
    { revision: 9, state: 'READY', type: 'standard' },
    { revision: 3, state: 'READY', type: 'windows' },
    { revision: 3, state: 'READY', type: 'linux' },
  ];

  assert.equal(classifyPackageStatus(problemWithPackage, packages), 'FULL');
});

test('full package FAILED trong lịch sử không được tính là đã có full', () => {
  const packages = [
    { revision: 9, state: 'READY', type: 'standard' },
    { revision: 2, state: 'FAILED', type: 'windows' },
    { revision: 2, state: 'FAILED', type: 'linux' },
  ];

  assert.equal(classifyPackageStatus(problemWithPackage, packages), 'STANDARD');
});

test('problem không có package READY được phân loại là chưa build', () => {
  assert.equal(classifyPackageStatus({ id: 2 }, []), 'UNBUILT');
  assert.equal(classifyPackageStatus(problemWithPackage, [
    { revision: 9, state: 'FAILED', type: 'standard' },
  ]), 'UNBUILT');
});

test('giao diện giữ problem chưa build, Standard hoặc có working copy chưa commit', () => {
  assert.equal(isEligibleProblem({ packageStatus: 'UNBUILT' }), true);
  assert.equal(isEligibleProblem({ packageStatus: 'STANDARD' }), true);
  assert.equal(isEligibleProblem({ packageStatus: 'FULL' }), false);
  assert.equal(isEligibleProblem({ packageStatus: 'LOADING' }), false);
  assert.equal(isEligibleProblem({ packageStatus: 'ERROR' }), false);
  assert.equal(isEligibleProblem({ packageStatus: 'FULL', modified: true }), true);
});

test('giao diện từ chối backend cũ chưa có bộ lọc lịch sử', () => {
  assert.equal(supportsPackageHistoryFilter({ ok: true }), false);
  assert.equal(supportsPackageHistoryFilter({
    ok: true,
    capabilities: ['full-package-history-filter-v1'],
  }), false);
  assert.equal(supportsPackageHistoryFilter({
    ok: true,
    capabilities: ['full-package-history-filter-v1', 'auto-commit-before-build-v1'],
  }), true);
});

test('trạng thái FULL đã lưu được ưu tiên và không bị kiểm tra lại', () => {
  const statuses = new Map([['42', 'FULL']]);
  assert.equal(resolveInitialPackageStatus({ id: 42 }, statuses), 'FULL');
  assert.equal(resolveInitialPackageStatus({ id: 43 }, statuses), 'UNBUILT');
  assert.equal(resolveInitialPackageStatus({ id: 44, latestPackage: 9 }, statuses), 'LOADING');
  assert.equal(resolveInitialPackageStatus({ id: 45, latestPackage: 9, modified: true }, statuses), 'UNBUILT');
});
