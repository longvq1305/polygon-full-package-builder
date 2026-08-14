export const requiredServerCapabilities = [
  'full-package-history-filter-v1',
  'auto-commit-before-build-v1',
];

export function isEligibleProblem(problem) {
  return Boolean(problem.modified)
    || problem.packageStatus === 'UNBUILT'
    || problem.packageStatus === 'STANDARD';
}

export function supportsPackageHistoryFilter(health) {
  return requiredServerCapabilities.every((capability) => health?.capabilities?.includes(capability));
}
