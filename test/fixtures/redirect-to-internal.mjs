// A public website that redirects into the internal network, without a public DNS: the name redirect.example.test
// resolves to a public address and answers 302 to inner.example.test, which resolves to 10.0.0.5. Only these two
// names are faked; the importer's own address checks stay untouched (documentation 11.1, RE-03, MC-10).
import dns from 'node:dns';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
const names = { 'redirect.example.test': '93.184.216.34', 'inner.example.test': '10.0.0.5' };
const lookup = dns.promises.lookup;
dns.promises.lookup = (host, options) =>
  Object.hasOwn(names, host)
    ? Promise.resolve(options?.all ? [{ address: names[host], family: 4 }] : { address: names[host], family: 4 })
    : lookup(host, options);
syncBuiltinESMExports();
const get = http.get;
http.get = (url, options, callback) => {
  if (new URL(url).hostname !== 'redirect.example.test') return get(url, options, callback);
  // The stand-in of the remote server: a redirect into the internal network.
  const request = Object.assign(new EventEmitter(), {
    setTimeout: () => request,
    destroy: (error) => error && request.emit('error', error),
  });
  setImmediate(() => {
    callback({ statusCode: 302, headers: { location: 'http://inner.example.test/admin' }, resume() {} });
    request.emit('close');
  });
  return request;
};
// The link check (documentation 4.11, RE-06) asks with http.request: the same stand-in redirect, and two more faked
// public names, one that exists (200) and one that is gone (404).
Object.assign(names, { 'ok.example.test': '93.184.216.34', 'gone.example.test': '93.184.216.34' });
const request = http.request;
http.request = (url, options, callback) => {
  const host = new URL(url).hostname,
    status = { 'redirect.example.test': 302, 'ok.example.test': 200, 'gone.example.test': 404 }[host];
  if (!status) return request(url, options, callback);
  const stand = Object.assign(new EventEmitter(), {
    setTimeout: () => stand,
    destroy: (error) => error && stand.emit('error', error),
    end: () =>
      setImmediate(() =>
        callback({
          statusCode: status,
          headers: status === 302 ? { location: 'http://inner.example.test/admin' } : {},
          destroy() {},
        }),
      ),
  });
  return stand;
};
