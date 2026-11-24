'use strict';
// Admin side of the #779 S8 check: an owned DNS listener for the synthetic
// '.freedom-audit.test' namespace (routed here by a temporary NRPT rule).
// Logs every query name and answers NXDOMAIN, so nothing goes upstream.
const dgram = require('node:dgram');
const fs = require('node:fs');
const out = 'C:/e2e/dns/packets.log';
const socket = dgram.createSocket('udp4');
function qname(packet) {
  const labels = []; let offset = 12;
  while (offset < packet.length && packet[offset]) { labels.push(packet.toString('ascii', offset + 1, offset + 1 + packet[offset])); offset += packet[offset] + 1; }
  return labels.join('.');
}
socket.on('message', (query, remote) => {
  if (query.length < 12) return;
  fs.appendFileSync(out, `${new Date().toISOString()} ${qname(query)} from ${remote.address}:${remote.port}\n`);
  const response = Buffer.from(query);
  response.writeUInt16BE(0x8183, 2);
  socket.send(response, remote.port, remote.address);
});
socket.bind(53, '127.0.0.1', () => fs.appendFileSync(out, `${new Date().toISOString()} listening\n`));
