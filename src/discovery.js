import dgram from 'node:dgram';
import os from 'node:os';

/**
 * Returns active IPv4 network interfaces categorized by type
 */
export function getNetworkDetails() {
  const ifaces = os.networkInterfaces();
  const list = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        let type = 'Local LAN';
        if (name.toLowerCase().includes('radmin') || addr.address.startsWith('26.')) {
          type = 'Radmin VPN';
        } else if (name.toLowerCase().includes('tailscale') || addr.address.startsWith('100.')) {
          type = 'Tailscale';
        } else if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless')) {
          type = 'Wi-Fi';
        } else if (name.toLowerCase().includes('ethernet')) {
          type = 'Ethernet';
        }

        list.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          type
        });
      }
    }
  }

  return list;
}

/**
 * Computes all broadcast IP addresses for local network and VPN adapters
 */
export function getBroadcastAddresses() {
  const broadcasts = ['255.255.255.255'];
  const netDetails = getNetworkDetails();

  for (const item of netDetails) {
    try {
      const ipParts = item.address.split('.').map(Number);
      const maskParts = item.netmask.split('.').map(Number);
      const bcastParts = ipParts.map((b, i) => (b | (~maskParts[i] & 255)));
      broadcasts.push(bcastParts.join('.'));
    } catch {}
  }

  return [...new Set(broadcasts)];
}

/**
 * Starts UDP beacon responder on the Host so clients can auto-discover it
 */
export function startHostDiscovery(port = 4455, udpPort = 4456) {
  let socket = null;
  let beaconTimer = null;

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'DISCOVER') {
          const reply = JSON.stringify({
            type: 'HOST_ANNOUNCE',
            name: os.hostname(),
            port: port,
            interfaces: getNetworkDetails().map(i => ({ ip: i.address, type: i.type }))
          });
          socket.send(reply, rinfo.port, rinfo.address);
        }
      } catch {}
    });

    socket.on('error', () => {
      // Ignore bind collision if already running
    });

    socket.bind(udpPort, () => {
      try {
        socket.setBroadcast(true);
      } catch {}

      // Periodic unsolicited announcement
      beaconTimer = setInterval(() => {
        try {
          const announce = JSON.stringify({
            type: 'HOST_ANNOUNCE',
            name: os.hostname(),
            port: port,
            interfaces: getNetworkDetails().map(i => ({ ip: i.address, type: i.type }))
          });
          for (const bcast of getBroadcastAddresses()) {
            socket.send(announce, udpPort, bcast, () => {});
          }
        } catch {}
      }, 2500);
    });
  } catch {}

  return {
    close() {
      if (beaconTimer) clearInterval(beaconTimer);
      if (socket) {
        try { socket.close(); } catch {}
        socket = null;
      }
    }
  };
}

/**
 * Scans local network and Radmin VPN for active YTSync hosts
 * @param {number} timeoutMs
 * @returns {Promise<Array<{name: string, ip: string, port: number, type: string}>>}
 */
export async function scanForHosts(timeoutMs = 1500, udpPort = 4456) {
  return new Promise((resolve) => {
    let socket = null;
    const hostsMap = new Map();

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }

    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'HOST_ANNOUNCE' && data.port) {
          const hostName = data.name || 'YTSync Host';
          const hostPort = data.port || 4455;
          const remoteIp = rinfo.address;

          if (remoteIp === '127.0.0.1') return;

          // Determine connection type
          let connType = 'Local LAN';
          if (remoteIp.startsWith('26.')) {
            connType = 'Radmin VPN';
          } else if (remoteIp.startsWith('100.')) {
            connType = 'Tailscale';
          }

          const hostKey = `${hostName}:${hostPort}`;
          const existing = hostsMap.get(hostKey);
          if (!existing || (existing.type !== 'Radmin VPN' && connType === 'Radmin VPN')) {
            hostsMap.set(hostKey, {
              name: hostName,
              ip: remoteIp,
              port: hostPort,
              type: connType
            });
          }
        }
      } catch {}
    });

    socket.on('error', () => {});

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {}

      const discoverMsg = JSON.stringify({ type: 'DISCOVER' });
      for (const bcast of getBroadcastAddresses()) {
        try {
          socket.send(discoverMsg, udpPort, bcast, () => {});
        } catch {}
      }
    });

    setTimeout(() => {
      try { socket.close(); } catch {}
      const results = Array.from(hostsMap.values());
      // Prioritize Radmin VPN first, then LAN, then others
      results.sort((a, b) => {
        if (a.type === 'Radmin VPN') return -1;
        if (b.type === 'Radmin VPN') return 1;
        return 0;
      });
      resolve(results);
    }, timeoutMs);
  });
}
