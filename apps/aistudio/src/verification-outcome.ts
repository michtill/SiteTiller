// Normalization applies only to valid model responses, never provider/protocol errors.
export function verificationOutcome(value: any, files: Record<string, string>) {
  if (
    !value ||
    !['PASS', 'FAIL'].includes(value.status) ||
    !Array.isArray(value.requiredFixes) ||
    value.requiredFixes.some((x: any) => typeof x !== 'string') ||
    (value.warnings !== undefined &&
      (!Array.isArray(value.warnings) || value.warnings.some((x: any) => typeof x !== 'string'))) ||
    (value.technicalFindings !== undefined && !Array.isArray(value.technicalFindings))
  )
    throw Error('Verifier nevrátil platný PASS/FAIL.');
  const warnings: string[] = [],
    requiredFixes: string[] = [];
  for (const finding of value.technicalFindings || []) {
    if (
      finding &&
      typeof finding.message === 'string' &&
      finding.message.trim() &&
      typeof finding.path === 'string' &&
      typeof finding.evidence === 'string' &&
      finding.evidence.trim() &&
      Object.hasOwn(files, finding.path) &&
      files[finding.path].includes(finding.evidence)
    )
      requiredFixes.push(finding.message);
    else warnings.push('Technický nález ověřovacího agenta nemá doložený zdroj; vyžaduje ruční posouzení.');
  }
  for (const warning of value.warnings || []) if (warning.trim()) warnings.push(warning);
  for (const issue of value.requiredFixes) if (issue.trim() && !requiredFixes.includes(issue)) warnings.push(issue);
  if (value.status === 'FAIL' && !requiredFixes.length && !warnings.length)
    warnings.push('Ověřovací agent úpravu nepotvrdil, ale nedoložil konkrétní technickou chybu.');
  return {
    status: requiredFixes.length ? 'FAIL' : 'PASS',
    requiredFixes: [...new Set(requiredFixes)],
    warnings: [...new Set(warnings)],
    modelVerdict: value.status,
    modelResult: value,
  };
}
export function outcomeWarnings(...groups: (string[] | undefined)[]) {
  return [...new Set(groups.flatMap((g) => g || []).filter((w) => !w.startsWith('External services are blocked')))];
}
