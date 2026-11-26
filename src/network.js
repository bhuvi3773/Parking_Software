import os from 'node:os';

/**
 * Find the best non-internal IPv4 LAN address for QR codes scanned by phones on Wi-Fi.
 */
export function getLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        candidates.push(entry.address);
      }
    }
  }

  const preferred =
    candidates.find((ip) => ip.startsWith('192.168.')) ||
    candidates.find((ip) => ip.startsWith('10.')) ||
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    candidates[0];

  return preferred || '127.0.0.1';
}

/**
 * Build a phone-scannable base URL from the incoming request, swapping localhost for LAN IP.
 */
export function createBaseUrlResolver(listenPort) {
  return (req) => {
    const hostHeader = req.get('host') || `localhost:${listenPort}`;
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const [hostname, portPart] = hostHeader.split(':');
    const port = portPart || String(listenPort);

    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      const lanIp = getLanIp();
      const suffix = port === '80' || port === '443' ? '' : `:${port}`;
      return `${proto}://${lanIp}${suffix}`;
    }

    return `${proto}://${hostHeader}`;
  };
}
