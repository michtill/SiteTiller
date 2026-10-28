// The checks of one request: the technical check and the requirements verification (on by default) and the
// completeness check (off by default, documentation 4.11).
export function requestChecks(value: unknown) {
  if (value === undefined) return { technical: true, verification: true, completeness: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Neplatné nastavení kontrol.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((k) => !['technical', 'verification', 'completeness'].includes(k)) ||
    Object.values(input).some((v) => typeof v !== 'boolean')
  )
    throw Error('Neplatné nastavení kontrol.');
  return {
    technical: input.technical !== false,
    verification: input.verification !== false,
    completeness: input.completeness === true,
  };
}
