import assert from 'node:assert/strict';
import test from 'node:test';
import { isEligibleProblem } from '../public/package-status.js';
import { classifyPackageStatus } from '../src/server.js';

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

test('giao diện chỉ giữ problem chưa build hoặc Standard', () => {
  assert.equal(isEligibleProblem({ packageStatus: 'UNBUILT' }), true);
  assert.equal(isEligibleProblem({ packageStatus: 'STANDARD' }), true);
  assert.equal(isEligibleProblem({ packageStatus: 'FULL' }), false);
  assert.equal(isEligibleProblem({ packageStatus: 'LOADING' }), false);
  assert.equal(isEligibleProblem({ packageStatus: 'ERROR' }), false);
});
