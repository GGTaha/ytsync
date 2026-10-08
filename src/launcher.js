import readline from 'node:readline';
import { scanForHosts, getNetworkDetails } from './discovery.js';

function promptLine(promptText) {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    let buffer = '';

    const onKey = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        process.stdin.removeListener('keypress', onKey);
        process.stdout.write('\n');
        process.exit(0);
      }

      if ((key && key.name === 'return') || str === '\r' || str === '\n') {
        process.stdin.removeListener('keypress', onKey);
        process.stdout.write('\n');
        resolve(buffer.trim());
        return;
      }

      if ((key && (key.name === 'backspace' || key.name === 'delete')) || str === '\x08' || str === '\x7f') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
        buffer += str;
        process.stdout.write(str);
      }
    };

    process.stdin.on('keypress', onKey);
  });
}

function promptSingleKey() {
  return new Promise((resolve) => {
    const onKey = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        process.stdin.removeListener('keypress', onKey);
        process.stdout.write('\n');
        process.exit(0);
      }

      process.stdin.removeListener('keypress', onKey);
      resolve({ str: str || '', key: key || {} });
    };

    process.stdin.on('keypress', onKey);
  });
}

/**
 * Runs the interactive TUI startup launcher
 * @returns {Promise<{isHost: boolean, port: number, join: string|null}>}
 */
export async function runInteractiveLauncher() {
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  while (true) {
    process.stdout.write('\x1B[2J\x1B[H'); // Clear screen

    process.stdout.write('\x1B[36m╔══════════════════════════════════════════════════════════════════════╗\x1B[0m\n');
    process.stdout.write('\x1B[36m║\x1B[0m \x1B[1m\x1B[33m                   🎵 YTSYNC TERMINAL MUSIC PLAYER                  \x1B[0m \x1B[36m║\x1B[0m\n');
    process.stdout.write('\x1B[36m╚══════════════════════════════════════════════════════════════════════╝\x1B[0m\n\n');

    // Display local network details
    const ifaces = getNetworkDetails();
    const radminIface = ifaces.find(i => i.type === 'Radmin VPN');
    const lanIface = ifaces.find(i => i.type !== 'Radmin VPN');

    process.stdout.write(' \x1B[90mYour Network Information:\x1B[0m\n');
    if (radminIface) {
      process.stdout.write(`   \x1B[32m●\x1B[0m Radmin VPN IP:  \x1B[1m\x1B[37m${radminIface.address}\x1B[0m\n`);
    } else {
      process.stdout.write('   \x1B[90m○ Radmin VPN:      (Not connected)\x1B[0m\n');
    }
    if (lanIface) {
      process.stdout.write(`   \x1B[34m●\x1B[0m Local LAN IP:   \x1B[1m\x1B[90m${lanIface.address}\x1B[0m\n`);
    }
    process.stdout.write('\x1B[90m────────────────────────────────────────────────────────────────────────\x1B[0m\n\n');

    process.stdout.write(' \x1B[1mSelect an option:\x1B[0m\n\n');
    process.stdout.write('   \x1B[33m[1]\x1B[0m 🏠 \x1B[1mHost a Session\x1B[0m          (Start your room & allow peers to join)\n');
    process.stdout.write('   \x1B[33m[2]\x1B[0m 🔍 \x1B[1mJoin a Session\x1B[0m          (Auto-scan for available rooms)\n');
    process.stdout.write('   \x1B[33m[3]\x1B[0m ⌨️  \x1B[1mJoin by IP Manually\x1B[0m     (Enter friend\'s Radmin IP directly)\n');
    process.stdout.write('   \x1B[33m[q]\x1B[0m ❌ \x1B[90mExit\x1B[0m\n\n');
    process.stdout.write(' \x1B[36mPress 1, 2, 3, or q:\x1B[0m ');

    const { str, key } = await promptSingleKey();
    process.stdout.write(`${str}\n\n`);

    if (str === 'q' || (key && key.name === 'q')) {
      process.stdout.write('\x1B[?25h\x1B[0mGoodbye!\n');
      process.exit(0);
    }

    // --- 1. HOST ---
    if (str === '1') {
      return {
        isHost: true,
        port: 4455,
        join: null
      };
    }

    // --- 2. JOIN VIA AUTO-SCAN ---
    if (str === '2') {
      const selectedHost = await runScanSubmenu();
      if (selectedHost) {
        return {
          isHost: false,
          port: 4455,
          join: selectedHost
        };
      }
      // If user pressed back, loop continues
      continue;
    }

    // --- 3. MANUAL IP ---
    if (str === '3') {
      const manualHost = await runManualIpPrompt();
      if (manualHost) {
        return {
          isHost: false,
          port: 4455,
          join: manualHost
        };
      }
      continue;
    }
  }
}

async function runScanSubmenu() {
  while (true) {
    process.stdout.write('\n \x1B[36m🔍 Scanning network and Radmin VPN for active rooms...\x1B[0m\n');
    const hosts = await scanForHosts(1600);

    process.stdout.write('\n\x1B[90m────────────────────────────────────────────────────────────────────────\x1B[0m\n');
    if (hosts.length === 0) {
      process.stdout.write(' \x1B[33mNo active hosts found automatically.\x1B[0m\n');
      process.stdout.write(' \x1B[90m(Make sure your friend has started hosting on the same Radmin network)\x1B[0m\n\n');
      process.stdout.write(' Options: \x1B[33m[r]\x1B[0m Rescan  │  \x1B[33m[m]\x1B[0m Enter IP manually  │  \x1B[33m[b]\x1B[0m Back to menu\n');
      process.stdout.write(' \x1B[36mSelect option:\x1B[0m ');

      const { str } = await promptSingleKey();
      process.stdout.write(`${str}\n`);

      if (str === 'r') continue;
      if (str === 'm') return await runManualIpPrompt();
      return null; // back
    } else {
      process.stdout.write(` \x1B[1m\x1B[32mFound ${hosts.length} active room(s):\x1B[0m\n\n`);
      hosts.forEach((h, idx) => {
        const typeBadge = h.type === 'Radmin VPN' ? '\x1B[32m[Radmin VPN]\x1B[0m' : '\x1B[34m[Local LAN]\x1B[0m';
        process.stdout.write(`   \x1B[33m[${idx + 1}]\x1B[0m \x1B[1m${h.name}\x1B[0m (${h.ip}:${h.port}) ${typeBadge}\n`);
      });

      process.stdout.write('\n Options: \x1B[33m[1-' + hosts.length + ']\x1B[0m Connect  │  \x1B[33m[r]\x1B[0m Rescan  │  \x1B[33m[m]\x1B[0m Manual IP  │  \x1B[33m[b]\x1B[0m Back\n');
      process.stdout.write(' \x1B[36mSelect option:\x1B[0m ');

      const { str } = await promptSingleKey();
      process.stdout.write(`${str}\n`);

      if (str === 'r') continue;
      if (str === 'm') return await runManualIpPrompt();
      if (str === 'b' || str === 'q') return null;

      const num = parseInt(str, 10);
      if (!isNaN(num) && num >= 1 && num <= hosts.length) {
        const chosen = hosts[num - 1];
        return `${chosen.ip}:${chosen.port}`;
      }
    }
  }
}

async function runManualIpPrompt() {
  process.stdout.write('\n');
  const input = await promptLine(' \x1B[1m\x1B[36mEnter Host IP address (e.g. 26.1.68.220):\x1B[0m ');
  if (!input) return null;

  let target = input.trim();
  // Automatically append port 4455 if omitted
  if (!target.includes(':')) {
    target = `${target}:4455`;
  }
  return target;
}
