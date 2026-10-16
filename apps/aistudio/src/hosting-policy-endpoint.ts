import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostingPolicyPath } from './hosting-policy-probe.ts';
export type RuntimePolicy = { status: number; contentSecurityPolicy: string | null };
// Only an owner-constructed runtime handler is accepted. No request-selected URL,
// directory, headers or path can affect this fixed HEAD / readiness/policy read.
export async function runtimeRootPolicy(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  origin: string,
): Promise<RuntimePolicy> {
  const headers = new Map<string, unknown>(),
    capture: any = {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      writeHead(status: number, values?: Record<string, unknown>) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [name, value] of Object.entries(values || {})) this.setHeader(name, value);
        return this;
      },
      end() {
        this.headersSent = true;
        return this;
      },
    };
  const request = {
    method: 'HEAD',
    url: '/',
    headers: { host: new URL(origin).host },
    socket: { remoteAddress: '127.0.0.1' },
  } as IncomingMessage;
  await handler(request, capture as ServerResponse);
  const csp = headers.get('content-security-policy');
  return { status: capture.statusCode, contentSecurityPolicy: typeof csp === 'string' ? csp : null };
}
export async function serveHostingPolicy(
  req: IncomingMessage,
  res: ServerResponse,
  probe: () => Promise<RuntimePolicy>,
) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'HEAD' });
    return res.end();
  }
  if (req.url !== hostingPolicyPath) {
    res.writeHead(400);
    return res.end();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const policy = await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Hosting runtime probe timed out')), 10000);
      }),
    ]);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (policy.contentSecurityPolicy) headers['Content-Security-Policy'] = policy.contentSecurityPolicy;
    res.writeHead(policy.status, headers);
    res.end();
  } catch {
    res.writeHead(502, { 'Cache-Control': 'no-store' });
    res.end();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
