/** Strict, bounded SOCKS5 CONNECT to managed loopback Arti. No DNS lookup,
 * no no-auth fallback, SOCKS4, UDP, proxy chains, or application protocols.
 */
const net = require('net');
const { privacyError } = require('./privacy-context');

function connectIsolatedSocks({ endpoint, hostname, port, token, signal, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    if (!endpoint || !['127.0.0.1', '::1'].includes(endpoint.host) ||
        !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
        !Number.isInteger(port) || port < 1 || port > 65535 ||
        typeof hostname !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(hostname) ||
        Buffer.byteLength(hostname) > 255 || !/^[0-9a-f]{64}$/.test(token) ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      reject(privacyError('INVALID_SOCKS_REQUEST', 'Invalid isolated SOCKS request'));
      return;
    }
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let phase = 'method';
    let settled = false;
    const error = (code = 'SOCKS_PROTOCOL_ERROR') => privacyError(code, 'Isolated SOCKS connection failed');
    const onAbort = () => finish(error('PRIVACY_REQUEST_ABORTED'));
    const onError = () => finish(error('SOCKS_CONNECTION_FAILED'));
    const onClose = () => finish(error('SOCKS_CONNECTION_CLOSED'));
    const timer = setTimeout(() => finish(error('SOCKS_TIMEOUT')), timeoutMs);
    timer.unref();

    function finish(failure) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      endpoint.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      // A destroy/connect race may emit an error after handshake cleanup.
      socket.on('error', () => {});
      if (failure) {
        socket.destroy();
        reject(failure);
      } else {
        socket.pause();
        if (buffer.length) socket.unshift(buffer);
        resolve(socket);
      }
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      // The largest supported SOCKS reply is 262 bytes. Arti cannot send
      // application data before the HTTP/TLS client initiates it.
      if (buffer.length > 512) return finish(error());
      if (phase === 'method' && buffer.length >= 2) {
        if (buffer[0] !== 5 || buffer[1] !== 2) return finish(error('SOCKS_AUTH_REQUIRED'));
        buffer = buffer.subarray(2);
        const username = '<torS0X>0';
        // Keep isolation credentials out of the shared Buffer pool.
        const authentication = Buffer.alloc(3 + username.length + Buffer.byteLength(token));
        authentication[0] = 1; authentication[1] = username.length;
        authentication.write(username, 2);
        authentication[2 + username.length] = Buffer.byteLength(token);
        authentication.write(token, 3 + username.length);
        socket.write(authentication, () => authentication.fill(0));
        phase = 'auth';
      }
      if (phase === 'auth' && buffer.length >= 2) {
        if (buffer[0] !== 1 || buffer[1] !== 0) return finish(error('SOCKS_AUTH_FAILED'));
        buffer = buffer.subarray(2);
        const host = Buffer.from(hostname, 'ascii');
        const targetPort = Buffer.alloc(2);
        targetPort.writeUInt16BE(port);
        // ATYP=domain: Arti resolves the destination, never Node's resolver.
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, targetPort]));
        phase = 'reply';
      }
      if (phase === 'reply' && buffer.length >= 4) {
        if (buffer[0] !== 5 || buffer[1] !== 0 || buffer[2] !== 0) return finish(error());
        let length;
        if (buffer[3] === 1) length = 10;
        else if (buffer[3] === 4) length = 22;
        else if (buffer[3] === 3) {
          if (buffer.length < 5) return;
          if (buffer[4] === 0) return finish(error());
          length = 7 + buffer[4];
        } else return finish(error());
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        finish();
      }
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    endpoint.signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted || endpoint.signal?.aborted) return onAbort();
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 2])));
    socket.connect(endpoint.port, endpoint.host);
  });
}

module.exports = { connectIsolatedSocks };
