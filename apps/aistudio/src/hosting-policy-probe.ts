import { hostingPolicyProblems } from './site-policy.ts';
export const hostingPolicyPath = '/.well-known/sitetiller-hosting-policy';
export function hostingPolicyProbeUrl(productionUrl: string, configured?: string) {
  let production: URL, probe: URL;
  try {
    production = new URL(productionUrl);
    probe = new URL(configured || productionUrl);
  } catch {
    throw Error('Invalid fixed hosting policy probe');
  }
  if (
    !['http:', 'https:'].includes(production.protocol) ||
    production.username ||
    production.password ||
    !['http:', 'https:'].includes(probe.protocol) ||
    probe.origin !== production.origin ||
    probe.username ||
    probe.password
  )
    throw Error('Invalid fixed hosting policy probe');
  if (configured) {
    const rawPath = configured.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+(\/[^?#]*)?/i)?.[1];
    if (
      probe.pathname !== hostingPolicyPath ||
      rawPath !== hostingPolicyPath ||
      configured.includes('?') ||
      configured.includes('#') ||
      configured.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)?.[1].includes('@')
    )
      throw Error('Invalid fixed hosting policy probe');
  }
  return probe;
}
export async function assertHostingPolicy(productionUrl: string, configured?: string, fetcher: typeof fetch = fetch) {
  const probe = hostingPolicyProbeUrl(productionUrl, configured),
    response = await fetcher(probe, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      redirect: 'error',
    });
  if (response.redirected || (response.status >= 300 && response.status < 400))
    throw Error('Hosting policy probe must not redirect');
  if (!response.ok) throw Error('Production hosting unavailable');
  const problems = hostingPolicyProblems(response.headers.get('content-security-policy'));
  if (problems.length) throw Error('Incompatible production CSP: ' + problems.join('; '));
}
