export function isEligibleProblem(problem) {
  return problem.packageStatus === 'UNBUILT' || problem.packageStatus === 'STANDARD';
}
