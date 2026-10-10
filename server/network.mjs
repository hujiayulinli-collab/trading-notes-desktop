import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

export const ipv4 = (address = '') => address.startsWith('::ffff:')
  ? address.slice(7) : address;
export const isLoopback = (address) => address === '::1' ||
  (isIP(ipv4(address)) === 4 && ipv4(address).startsWith('127.'));
export function isPrivateIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function lanInterfaces() {
  return Object.values(networkInterfaces()).flat().filter((item) =>
    item && !item.internal && isPrivateIPv4(item.address) && isIP(item.netmask) === 4);
}
function sameSubnet(address, network) {
  if (!isPrivateIPv4(address) || !isPrivateIPv4(network.address) ||
      isIP(network.netmask) !== 4) return false;
  const octets = address.split('.').map(Number);
  const local = network.address.split('.').map(Number);
  const mask = network.netmask.split('.').map(Number);
  return octets.every((octet, i) => (octet & mask[i]) === (local[i] & mask[i]));
}

export function networkAccess(req, port, { lan = false, interfaces = lanInterfaces() } = {}) {
  const peer = ipv4(req.socket.remoteAddress);
  const local = isLoopback(peer);
  const networks = interfaces.filter((item) => isPrivateIPv4(item.address));
  if (!local && (!lan || !networks.some((item) => sameSubnet(peer, item))))
    return '仅允许本机或已开启的同网段局域网访问。';

  const host = (req.headers.host || '').toLowerCase();
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173'];
  const lanHosts = lan ? networks.map((item) => `${item.address}:${port}`) : [];
  const hosts = [...(local ? localHosts : []), ...lanHosts];
  if (!hosts.includes(host)) return '访问地址不属于本机允许的地址。';

  const origins = new Set([`http://${host}`]);
  // The Vite development proxy is only available on loopback.
  if (local && localHosts.includes(host)) origins.add('http://127.0.0.1:5173');
  if (req.headers.origin && !origins.has(req.headers.origin))
    return '不允许此来源读取手记数据。';
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']))
    return '不允许其他网页跨源访问手记数据。';
  return null;
}

export function lanUrls(port, interfaces = lanInterfaces()) {
  return [...new Set(interfaces.filter((item) => isPrivateIPv4(item.address))
    .map((item) => `http://${item.address}:${port}/`))];
}
