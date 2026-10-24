import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The Shell as the instance's supervisor (documentation 2.6): it holds the ports of the other services and runs each
// service behind its port on a hidden one. A connection to a sleeping service is held, the service started, and the
// connection handed over; a service without open connections and without work is stopped after the idle time set in
// Settings, so its memory is really freed. A service that stopped on its own starts again with the next connection.
export type Service = {
  name: string;
  entry: string;
  port: number;
  host: string;
  // A service that never sleeps (the Website of an internal presentation) starts at once and stays up.
  sleeps: boolean;
  // Whether the service has no work of its own (the AI Studio after it answered 202); an error counts as working.
  idle?: (port: number) => Promise<boolean>;
};
type State = Service & {
  child: ChildProcess | null;
  internal: number;
  starting: Promise<number> | null;
  open: number;
  lastUsed: number;
  startedAt: number;
};
export type Supervisor = {
  asleep(name: string): boolean;
  wake(name: string): Promise<number>;
  stop(): Promise<void>;
  check(): Promise<void>;
};
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
const reachable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
export async function supervise(options: {
  repo: string;
  services: Service[];
  // The environment of one service, built fresh at every start (so a changed network mode applies).
  environment: (name: string) => Promise<Record<string, string | undefined>>;
  // Milliseconds of idleness before a service sleeps; 0 = never.
  idleTime: () => Promise<number>;
  // Where a service writes its output.
  output: (name: string, child: ChildProcess) => void;
  // The running services, for the Playground's restart of one of them.
  recordFile?: string;
  checkEvery?: number;
}): Promise<Supervisor> {
  const states = new Map<string, State>(
    options.services.map((service) => [
      service.name,
      { ...service, child: null, internal: 0, starting: null, open: 0, lastUsed: 0, startedAt: 0 },
    ]),
  );
  const record = async () => {
    if (!options.recordFile) return;
    const running = Object.fromEntries(
      [...states.values()]
        .filter((s) => s.child?.pid)
        .map((s) => [
          s.name,
          { name: s.name, pid: s.child!.pid, entry: join(options.repo, s.entry), startedAt: new Date(s.startedAt).toISOString() },
        ]),
    );
    await writeFile(options.recordFile, JSON.stringify(running, null, 2)).catch(() => {});
  };
  const start = (s: State): Promise<number> => {
    if (s.child && s.child.exitCode === null && !s.starting) return Promise.resolve(s.internal);
    if (s.starting) return s.starting;
    s.starting = (async () => {
      const internal = await freePort(),
        env = { ...(await options.environment(s.name)), SITETILLER_LISTEN_PORT: String(internal), HOST: '127.0.0.1' };
      const child = spawn(
        process.execPath,
        ['--import', pathToFileURL(join(options.repo, 'scripts/network-policy.mjs')).href, join(options.repo, s.entry)],
        { cwd: options.repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      options.output(s.name, child);
      child.on('exit', () => {
        if (s.child === child) s.child = null;
        void record();
      });
      for (let i = 0; i < 600; i++) {
        if (child.exitCode !== null) throw Error('Služba ' + s.name + ' se nespustila.');
        if (await reachable(internal)) {
          s.child = child;
          s.internal = internal;
          s.startedAt = s.lastUsed = Date.now();
          await record();
          return internal;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      child.kill();
      throw Error('Služba ' + s.name + ' se nespustila včas.');
    })().finally(() => {
      s.starting = null;
    });
    return s.starting;
  };
  const servers: net.Server[] = [];
  for (const s of states.values()) {
    const server = net.createServer((socket) => {
      s.open++;
      s.lastUsed = Date.now();
      socket.pause();
      socket.once('close', () => {
        s.open--;
        s.lastUsed = Date.now();
      });
      socket.on('error', () => {});
      start(s).then(
        (port) => {
          const upstream = net.connect(port, '127.0.0.1');
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
          socket.pipe(upstream).pipe(socket);
          socket.resume();
        },
        (error) => {
          const text = Buffer.from(error.message);
          socket.end(
            'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ' +
              text.length +
              '\r\nConnection: close\r\n\r\n' +
              text,
          );
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(s.port, s.host, () => resolve());
    });
    servers.push(server);
    if (!s.sleeps) void start(s).catch(() => {});
  }
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const idleTime = await options.idleTime().catch(() => 0);
      if (!idleTime) return;
      for (const s of states.values()) {
        if (!s.sleeps || !s.child || s.starting || s.open > 0) continue;
        if (Date.now() - Math.max(s.lastUsed, s.startedAt) < idleTime) continue;
        if (s.idle && !(await s.idle(s.internal).catch(() => false))) {
          s.lastUsed = Date.now();
          continue;
        }
        if (s.open > 0) continue;
        const child = s.child;
        s.child = null;
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
          setTimeout(() => (child.kill('SIGKILL'), resolve()), 10000).unref();
        });
        await record();
      }
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), options.checkEvery || 30000);
  timer.unref();
  return {
    asleep: (name) => {
      const s = states.get(name);
      return !!s && !s.child;
    },
    wake: (name) => start(states.get(name)!),
    check,
    async stop() {
      clearInterval(timer);
      for (const server of servers) server.close();
      await Promise.all(
        [...states.values()].map(
          (s) =>
            new Promise<void>((resolve) => {
              const child = s.child;
              if (!child || child.exitCode !== null) return resolve();
              child.once('exit', () => resolve());
              child.kill('SIGTERM');
              setTimeout(() => resolve(), 5000).unref();
            }),
        ),
      );
      await record();
    },
  };
}
