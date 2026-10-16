import { AsyncLocalStorage } from 'node:async_hooks';
// Stopping a running request: the request runs with a stop signal; provider calls end at once when it fires, and
// the workflow checks it before it changes the draft. A content write that is already running finishes first.
const stopSignal = new AsyncLocalStorage<AbortSignal>();
export class StoppedError extends Error {
  stopped = true;
  constructor() {
    super('Zastaveno uživatelem.');
  }
}
export function runWithStop<T>(signal: AbortSignal, work: () => Promise<T>) {
  return stopSignal.run(signal, work);
}
export function currentStopSignal() {
  return stopSignal.getStore();
}
export function throwIfStopped() {
  if (stopSignal.getStore()?.aborted) throw new StoppedError();
}
// Fetch options that also end when the request is stopped.
export function withStop(options: RequestInit): RequestInit {
  const stop = stopSignal.getStore();
  if (!stop) return options;
  if (stop.aborted) throw new StoppedError();
  return { ...options, signal: options.signal ? AbortSignal.any([options.signal, stop]) : stop };
}
