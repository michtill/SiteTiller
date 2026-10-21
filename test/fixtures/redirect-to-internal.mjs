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
