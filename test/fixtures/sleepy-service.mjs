import http from 'node:http';
// An invented service for the supervisor tests (documentation 2.6): it answers with its process id; ?hold keeps the
// connection open until ?release; FIXTURE_FAIL makes it exit at once.
if (process.env.FIXTURE_FAIL) process.exit(3);
let held = [];
http
  .createServer((req, res) => {
    if (req.url === '/hold') return held.push(res);
    if (req.url === '/release') {
      for (const r of held) r.end('released');
      held = [];
    }
    res.end(String(process.pid));
  })
  .listen(Number(process.env.SITETILLER_LISTEN_PORT), '127.0.0.1');
