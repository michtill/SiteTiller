// A minimal mail server on this computer for tests: it accepts every message and keeps it (no TLS, no auth checks).
import net from 'node:net';
export async function smtpCapture() {
  const messages = [];
  const server = net.createServer((socket) => {
    let data = false,
      message = { from: '', to: [], text: '' },
      buffer = '';
    socket.write('220 example.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            data = false;
            messages.push(message);
            message = { from: '', to: [], text: '' };
            socket.write('250 OK\r\n');
          } else message.text += line.replace(/^\.\./, '.') + '\n';
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-example.test\r\n250 AUTH PLAIN\r\n');
        else if (command === 'AUTH') socket.write('235 OK\r\n');
        else if (command === 'MAIL') {
          message.from = line.slice(10).replace(/[<>]/g, '').trim();
          socket.write('250 OK\r\n');
        } else if (command === 'RCPT') {
          message.to.push(line.slice(8).replace(/[<>]/g, '').trim());
          socket.write('250 OK\r\n');
        } else if (command === 'DATA') {
          data = true;
          socket.write('354 Go ahead\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 Bye\r\n');
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => {});
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { port, messages, close: () => new Promise((resolve) => server.close(resolve)) };
}
