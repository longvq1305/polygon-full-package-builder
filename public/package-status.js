export const requiredServerCapability = 'full-package-history-filter-v1';

export function isEligibleProblem(problem) {
  return problem.packageStatus === 'UNBUILT' || problem.packageStatus === 'STANDARD';
}

export function supportsPackageHistoryFilter(health) {
  return Boolean(health?.capabilities?.includes(requiredServerCapability));
}
