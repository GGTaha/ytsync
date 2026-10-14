import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import EventEmitter from 'node:events';
import crypto from 'node:crypto';

export class MpvController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.mpvBinary = options.mpvBinary || 'mpv';
    this.pipeName = `\\\\.\\pipe\\ytsync_mpv_${crypto.randomBytes(4).toString('hex')}`;
    this.process = null;
    this.socket = null;
    this.connected = false;
    this.requestId = 1;
    this.pendingRequests = new Map();
    this.buffer = '';

    // Cached states
    this.state = {
      timePos: 0,
      duration: 0,
      paused: false,
      title: '',
      idle: true,
      volume: 100,
      pausedForCache: false,
      cacheDuration: 0
    };
  }

  async start() {
    return new Promise((resolve, reject) => {
      const args = [
        '--idle=yes',
        '--no-video',
        '--terminal=no',
        '--cache=yes',
        '--demuxer-readahead-secs=60',
        '--demuxer-max-bytes=64M',
        '--speed=1.0',
        `--input-ipc-server=${this.pipeName}`
      ];

      this.process = spawn(this.mpvBinary, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start MPV (${this.mpvBinary}): ${err.message}`));
      });

      this.process.stderr.on('data', () => {});

      this.process.on('exit', (code) => {
        this.emit('exit', code);
        this.destroy();
      });

      // Poll connection to the named pipe
      let attempts = 0;
      const tryConnect = () => {
        attempts++;
        const socket = net.createConnection(this.pipeName, () => {
          this.socket = socket;
          this.connected = true;
          this._setupSocket();
          this._initObservers();
          resolve();
        });

        socket.on('error', () => {
          socket.destroy();
          if (attempts > 30) {
            reject(new Error(`Timed out connecting to MPV IPC pipe: ${this.pipeName}`));
          } else {
            setTimeout(tryConnect, 100);
          }
        });
      };

      setTimeout(tryConnect, 150);
    });
  }

  _setupSocket() {
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop(); // Keep unfinished line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          this._handleMessage(msg);
        } catch {
          // ignore invalid json chunks
        }
      }
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
    });
  }

  _handleMessage(msg) {
    if (msg.request_id && this.pendingRequests.has(msg.request_id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.request_id);
      this.pendingRequests.delete(msg.request_id);
      if (msg.error && msg.error !== 'success') {
        reject(new Error(msg.error));
      } else {
        resolve(msg.data);
      }
      return;
    }

    if (msg.event === 'property-change') {
      switch (msg.name) {
        case 'time-pos':
          if (typeof msg.data === 'number') {
            this.state.timePos = msg.data;
            this.emit('time-pos', msg.data);
          }
          break;
        case 'duration':
          if (typeof msg.data === 'number') {
            this.state.duration = msg.data;
            this.emit('duration', msg.data);
          }
          break;
        case 'pause':
          if (typeof msg.data === 'boolean') {
            this.state.paused = msg.data;
            this.emit('pause', msg.data);
          }
          break;
        case 'media-title':
          if (typeof msg.data === 'string') {
            this.state.title = msg.data;
            this.emit('title', msg.data);
          }
          break;
        case 'idle-active':
          if (typeof msg.data === 'boolean') {
            this.state.idle = msg.data;
            this.emit('idle', msg.data);
          }
          break;
        case 'paused-for-cache':
          if (typeof msg.data === 'boolean') {
            this.state.pausedForCache = msg.data;
            this.emit('paused-for-cache', msg.data);
          }
          break;
        case 'demuxer-cache-duration':
          if (typeof msg.data === 'number') {
            this.state.cacheDuration = msg.data;
            this.emit('cache-duration', msg.data);
          }
          break;
      }
    } else if (msg.event === 'end-file') {
      this.emit('end-file', msg.reason);
    }
  }

  async sendCommand(command) {
    if (!this.connected || !this.socket) {
      throw new Error('MPV socket not connected');
    }

    return new Promise((resolve, reject) => {
      const reqId = this.requestId++;
      this.pendingRequests.set(reqId, { resolve, reject });
      const payload = JSON.stringify({ command, request_id: reqId }) + '\n';
      this.socket.write(payload);
    });
  }

  async _initObservers() {
    await this.sendCommand(['observe_property', 1, 'time-pos']).catch(() => {});
    await this.sendCommand(['observe_property', 2, 'duration']).catch(() => {});
    await this.sendCommand(['observe_property', 3, 'pause']).catch(() => {});
    await this.sendCommand(['observe_property', 4, 'media-title']).catch(() => {});
    await this.sendCommand(['observe_property', 5, 'idle-active']).catch(() => {});
    await this.sendCommand(['observe_property', 6, 'paused-for-cache']).catch(() => {});
    await this.sendCommand(['observe_property', 7, 'demuxer-cache-duration']).catch(() => {});
  }

  async loadFile(url) {
    this.state.timePos = 0;
    this.state.duration = 0;
    this.state.pausedForCache = false;
    this.state.cacheDuration = 0;
    return this.sendCommand(['loadfile', url, 'replace']);
  }

  async waitUntilLoaded(timeoutMs = 15000) {
    if (!this.state.idle && (this.state.duration > 0 || this.state.cacheDuration > 0.5)) {
      return true;
    }

    return new Promise((resolve) => {
      let done = false;

      const check = () => {
        if (!done && !this.state.idle && (this.state.duration > 0 || this.state.cacheDuration > 0.5)) {
          done = true;
          cleanup();
          resolve(true);
        }
      };

      const onDuration = () => check();
      const onCache = () => check();
      const onIdle = () => check();

      this.on('duration', onDuration);
      this.on('cache-duration', onCache);
      this.on('idle', onIdle);

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          cleanup();
          resolve(!this.state.idle);
        }
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('duration', onDuration);
        this.removeListener('cache-duration', onCache);
        this.removeListener('idle', onIdle);
      };

      check();
    });
  }

  async play() {
    this.state.paused = false;
    try {
      return await this.sendCommand(['set_property', 'pause', false]);
    } catch {}
  }

  async pause() {
    this.state.paused = true;
    try {
      return await this.sendCommand(['set_property', 'pause', true]);
    } catch {}
  }

  async togglePause() {
    this.state.paused = !this.state.paused;
    try {
      return await this.sendCommand(['cycle', 'pause']);
    } catch {}
  }

  async seek(seconds) {
    this.state.timePos = seconds;
    try {
      return await this.sendCommand(['seek', seconds, 'absolute']);
    } catch {}
  }

  async relativeSeek(seconds) {
    try {
      return await this.sendCommand(['seek', seconds, 'relative']);
    } catch {}
  }

  async setVolume(volume) {
    const clamped = Math.max(0, Math.min(100, volume));
    this.state.volume = clamped;
    try {
      return await this.sendCommand(['set_property', 'volume', clamped]);
    } catch {}
  }

  async stop() {
    try {
      return await this.sendCommand(['stop']);
    } catch {}
  }

  destroy() {
    // 1. Tell MPV to quit cleanly over IPC socket
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(JSON.stringify({ command: ['quit'] }) + '\n');
      } catch {}
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }

    // 2. Kill the process and its full process tree
    if (this.process && this.process.pid) {
      const pid = this.process.pid;
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
        } else {
          this.process.kill('SIGKILL');
        }
      } catch {}
      this.process = null;
    }

    this.connected = false;
  }
}
