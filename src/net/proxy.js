// An optional SOCKS5 path, for networks that only allow outbound through one.
//
// This is environment plumbing, not part of what the tool does: it is inert unless
// SYNCPROOF_SOCKS5 is set (e.g. "127.0.0.1:7890"). Implemented over node:net and
// node:tls so the dependency list stays empty — a proxy library is not worth adding
// to a tool whose selling point is that it installs the same everywhere.

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { request as httpsRequest } from 'node:https';

/** Open a TCP tunnel to host:port through a SOCKS5 proxy, then start TLS on it. */
function socks5Tls({ proxyHost, proxyPort, host, port, servername }) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, proxyHost, () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));       // version 5, one method, no auth
    });
    sock.once('error', reject);

    const greet = (chunk) => {
      if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
        return reject(new Error(`SOCKS5 greeting rejected (${chunk[0]}/${chunk[1]}); only no-auth is supported`));
      }
      const name = Buffer.from(host, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),  // CONNECT, domain-name address type
        name,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]);
      sock.once('data', reply);
      sock.write(req);
    };

    const reply = (chunk) => {
      if (chunk[1] !== 0x00) return reject(new Error(`SOCKS5 CONNECT to ${host}:${port} failed with code ${chunk[1]}`));
      const tls = tlsConnect({ socket: sock, servername: servername || host }, () => resolve(tls));
      tls.once('error', reject);
    };

    sock.once('data', greet);
  });
}

/** A fetch-shaped call over the tunnel. Only the members this codebase uses. */
async function socksFetch(url, { method = 'GET', headers = {}, body } = {}, proxy) {
  const target = new URL(url);
  const [proxyHost, proxyPort] = proxy.split(':');
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : String(body), 'utf8');

  const socket = await socks5Tls({
    proxyHost, proxyPort: Number(proxyPort),
    host: target.hostname, port: Number(target.port || 443),
  });

  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      method,
      host: target.hostname,
      path: target.pathname + target.search,
      headers: {
        ...headers,
        ...(payload ? { 'content-length': String(payload.length) } : {}),
      },
      createConnection: () => socket,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * The fetch this process should use: the platform one, unless a SOCKS5 proxy is
 * configured. Everything downstream takes it as an argument, so nothing depends
 * on which one is in play.
 */
export function makeFetch(proxy = process.env.SYNCPROOF_SOCKS5) {
  if (!proxy) return fetch;
  const f = (url, init) => socksFetch(typeof url === 'string' ? url : url.toString(), init, proxy);
  f.viaProxy = proxy;
  return f;
}
