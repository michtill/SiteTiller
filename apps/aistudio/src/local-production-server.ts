import http from 'node:http';
import { isAbsolute } from 'node:path';
import { localProductionState } from './local-production.ts';
import { websiteServer } from './website-server.ts';
import { hostingPolicyPath } from './hosting-policy-probe.ts';
import { runtimeRootPolicy, serveHostingPolicy } from './hosting-policy-endpoint.ts';
const root = process.env.SITETILLER_LOCAL_PRODUCTION_ROOT;
if (!root) throw Error('Missing local production directory');
const origin = process.env.SITETILLER_SITE_ORIGIN || 'http://127.0.0.1:4312',
  preparedDirectory = process.env.SITETILLER_HOSTING_POLICY_DIRECTORY;
if (preparedDirectory && !isAbsolute(preparedDirectory))
  throw Error('Hosting policy directory must be an absolute operator-managed path');
const prepared = preparedDirectory ? websiteServer(preparedDirectory, origin) : undefined;
let active: string | undefined, handler: ReturnType<typeof websiteServer> | undefined;
http
  .createServer(async (req, res) => {
    try {
      const policy = new URL(req.url || '/', origin).pathname === hostingPolicyPath;
      if (policy) {
        return serveHostingPolicy(req, res, async () => {
          let target = prepared;
          if (!target) {
            const state = await localProductionState(root);
            if (!state) return { status: 503, contentSecurityPolicy: null };
            target = websiteServer(state.directory, origin);
          }
          return runtimeRootPolicy(target.listeners('request')[0] as any, origin);
        });
      }
      const state = await localProductionState(root);
      if (!state) {
        res.writeHead(503);
        return res.end('Lokální produkce dosud nebyla publikována.');
      }
      if (active !== state.id) {
        handler = websiteServer(state.directory, origin);
        active = state.id;
      }
      handler!.emit('request', req, res);
    } catch {
      res.writeHead(503);
      res.end('Lokální produkce není dostupná.');
    }
  })
  .listen(Number(process.env.PORT || 4312), process.env.HOST || '127.0.0.1');
