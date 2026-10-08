#!/usr/bin/env node

import { App } from './app.js';
import { TerminalUI } from './ui.js';
import { resolveBinary } from './utils.js';
import { runInteractiveLauncher } from './launcher.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    modeSpecified: false,
    isHost: true,
    port: 4455,
    join: null,
    mpvBinary: resolveBinary('mpv'),
    ytdlpBinary: resolveBinary('yt-dlp')
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
🎵 YTSync - Terminal YouTube Music Player with Peer Sync

Usage:
  node src/index.js [options]

Options:
  --host                  Start as Host
  --port <number>         Port to listen on (default: 4455)
  --join <ip:port>        Join a room as Guest (e.g. 26.12.34.56:4455)
  --mpv <path>            Custom path to mpv executable
  --ytdlp <path>          Custom path to yt-dlp executable
  -h, --help              Show this help message

Examples:
  Host a session:
    node src/index.js --host --port 4455

  Join a friend on Radmin VPN:
    node src/index.js --join 26.54.120.89:4455

  Interactive Menu (Auto-detect & Scan):
    node src/index.js
`);
      process.exit(0);
    } else if (arg === '--host') {
      options.modeSpecified = true;
      options.isHost = true;
    } else if (arg === '--join') {
      options.modeSpecified = true;
      options.isHost = false;
      options.join = args[++i];
    } else if (arg === '--port') {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--mpv') {
      options.mpvBinary = args[++i];
    } else if (arg === '--ytdlp') {
      options.ytdlpBinary = args[++i];
    }
  }

  if (options.modeSpecified && !options.isHost && !options.join) {
    console.error('Error: --join requires an address like <ip>:<port>');
    process.exit(1);
  }

  return options;
}

async function main() {
  const options = parseArgs();

  // If neither --host nor --join was explicitly passed, launch the interactive TUI
  if (!options.modeSpecified) {
    const selection = await runInteractiveLauncher();
    options.isHost = selection.isHost;
    options.port = selection.port || options.port;
    options.join = selection.join;
  }

  process.stdout.write('\x1B[2J\x1B[H\n \x1B[36m⏳ Initializing MPV and Sync Engine...\x1B[0m\n');

  const app = new App({
    isHost: options.isHost,
    port: options.port,
    join: options.join,
    mpvBinary: options.mpvBinary,
    ytdlpBinary: options.ytdlpBinary
  });

  const ui = new TerminalUI(app);
  app.onStatusChange = (msg) => ui.setStatus(msg);

  try {
    await app.init();
    ui.start();
  } catch (err) {
    ui.cleanup(false);
    console.error('\n❌ Initialization Error:');
    console.error(err.message);
    console.error('\nPlease verify that mpv and yt-dlp are installed and accessible.');
    process.exit(1);
  }
}

main();
