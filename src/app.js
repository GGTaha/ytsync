import { MpvController } from './mpv.js';
import { YouTubeService } from './youtube.js';
import { HostSync, ClientSync } from './sync.js';
import { startHostDiscovery, getNetworkDetails } from './discovery.js';

export class App {
  constructor(options = {}) {
    this.isHost = options.isHost ?? true;
    this.port = options.port || 4455;
    this.joinAddress = options.join || null;
    this.mpvBinary = options.mpvBinary || 'mpv';
    this.ytdlpBinary = options.ytdlpBinary || 'yt-dlp';

    this.mpv = new MpvController({ mpvBinary: this.mpvBinary });
    this.youtube = new YouTubeService({ ytdlpBinary: this.ytdlpBinary });

    this.sync = null;
    this.discovery = null;
    this.queue = [];
    this.currentTrack = null;
    this.peerCount = 0;
    this.pingMs = 0;

    const netDetails = getNetworkDetails();
    const radmin = netDetails.find(i => i.type === 'Radmin VPN');
    const localLan = netDetails.find(i => i.type !== 'Radmin VPN');
    const bestIp = radmin ? radmin.address : (localLan ? localLan.address : 'localhost');
    this.hostDisplayAddress = this.isHost ? `${bestIp}:${this.port}` : this.joinAddress;

    this.onStatusChange = options.onStatusChange || (() => {});
    this._suppressSyncBroadcast = false;
    this.lastTrackLoadTime = 0;
    this.lastAutoSeekTime = 0;
  }

  async init() {
    // 1. Start MPV process
    await this.mpv.start();

    // 2. Setup MPV listeners
    this.mpv.on('end-file', (reason) => {
      if (reason === 'eof' && this.isHost) {
        this.nextTrack();
      }
    });

    // Continuously update HostSync with actual playback time & pause state
    this.mpv.on('time-pos', (pos) => {
      if (this.isHost && this.sync && typeof pos === 'number') {
        this.sync.state.timePos = pos;
      }
    });

    this.mpv.on('pause', (isPaused) => {
      if (this.isHost && this.sync && typeof isPaused === 'boolean') {
        this.sync.state.paused = isPaused;
      }
    });

    // 3. Setup Sync
    if (this.isHost) {
      this.discovery = startHostDiscovery(this.port);
      this.sync = new HostSync({ port: this.port });
      this.sync.on('peer-connected', ({ total }) => {
        this.peerCount = total;
        this.onStatusChange(`Peer joined. Total peers: ${total}`);
      });
      this.sync.on('peer-disconnected', ({ total }) => {
        this.peerCount = total;
        this.onStatusChange(`Peer left. Total peers: ${total}`);
      });
      this.sync.on('action', ({ action, payload }) => {
        this._handlePeerAction(action, payload);
      });

      await this.sync.start();
    } else {
      const [host, portStr] = this.joinAddress.split(':');
      const port = portStr ? parseInt(portStr, 10) : 4455;

      this.sync = new ClientSync({ host, port });
      this.sync.on('connected', () => {
        this.onStatusChange(`Connected to host ${this.joinAddress}`);
      });
      this.sync.on('disconnected', () => {
        this.onStatusChange('Disconnected from host. Reconnecting...');
      });
      this.sync.on('ping', (ping) => {
        this.pingMs = ping;
      });

      this.sync.on('room-state', async (state) => {
        this.queue = state.queue || [];
        if (state.currentTrack) {
          await this._loadTrackLocally(state.currentTrack, state.timePos, state.paused);
        }
      });

      this.sync.on('load-track', async (track) => {
        await this._loadTrackLocally(track, 0, false);
      });

      this.sync.on('play', async ({ timePos }) => {
        this._suppressSyncBroadcast = true;
        await this.mpv.play();
        if (typeof timePos === 'number' && Math.abs(this.mpv.state.timePos - timePos) > 1.0) {
          await this.mpv.seek(timePos);
        }
        this._suppressSyncBroadcast = false;
      });

      this.sync.on('pause', async ({ timePos }) => {
        this._suppressSyncBroadcast = true;
        await this.mpv.pause();
        if (typeof timePos === 'number' && Math.abs(this.mpv.state.timePos - timePos) > 1.0) {
          await this.mpv.seek(timePos);
        }
        this._suppressSyncBroadcast = false;
      });

      this.sync.on('seek', async ({ timePos }) => {
        this._suppressSyncBroadcast = true;
        await this.mpv.seek(timePos);
        this._suppressSyncBroadcast = false;
      });

      this.sync.on('queue-update', (queue) => {
        this.queue = queue;
      });

      this.sync.on('heartbeat', async ({ timePos, paused }) => {
        if (!this.currentTrack || this.mpv.state.idle) return;

        // 1. Never interrupt the initial 6-second buffering window of a track
        const now = Date.now();
        if (now - this.lastTrackLoadTime < 6000) {
          return;
        }

        // 2. Cooldown: do not issue repeated seeks within 5 seconds
        if (now - this.lastAutoSeekTime < 5000) {
          return;
        }

        // 3. Align pause states
        if (this.mpv.state.paused !== paused) {
          if (paused) await this.mpv.pause();
          else await this.mpv.play();
        }

        // 4. Drift correction: only if both sides have active rolling audio (> 0.5s) and drift > 2.5s
        if (!paused && !this.mpv.state.paused && this.mpv.state.timePos > 0.5 && timePos > 0.5) {
          const drift = Math.abs(this.mpv.state.timePos - timePos);
          if (drift > 2.5) {
            this.lastAutoSeekTime = now;
            await this.mpv.seek(timePos);
          }
        }
      });

      this.sync.connect();
    }
  }

  async _loadTrackLocally(track, startPos = 0, paused = false) {
    if (!track) {
      this.currentTrack = null;
      await this.mpv.stop();
      this.onStatusChange('Queue finished.');
      return;
    }

    this.currentTrack = track;
    this.lastTrackLoadTime = Date.now();
    this.lastAutoSeekTime = Date.now();
    this.onStatusChange(`Loading: ${track.title}...`);

    try {
      const url = track.url || (track.id ? `https://www.youtube.com/watch?v=${track.id}` : null);
      if (!url) return;

      await this.mpv.loadFile(url);

      if (startPos > 0) {
        await this.mpv.seek(startPos);
      }
      if (paused) {
        await this.mpv.pause();
      } else {
        await this.mpv.play();
      }
      this.onStatusChange(`Playing: ${track.title}`);
    } catch (err) {
      this.onStatusChange(`Playback error: ${err.message}`);
    }
  }

  async _handlePeerAction(action, payload) {
    switch (action) {
      case 'PLAY':
        await this.togglePlayPause(false);
        break;
      case 'PAUSE':
        await this.togglePlayPause(true);
        break;
      case 'SEEK':
        await this.seekAbsolute(payload.timePos);
        break;
      case 'NEXT':
        await this.nextTrack();
        break;
      case 'ADD_QUEUE':
        await this.enqueueOrPlay(payload.track);
        break;
    }
  }

  async enqueueOrPlay(track) {
    if (!track) return;
    if (!this.isHost) {
      this.sync.sendAction('ADD_QUEUE', { track });
      this.onStatusChange(`Sent to host queue: ${track.title}`);
      return;
    }

    const isIdle = !this.currentTrack || this.mpv.state.idle;
    if (isIdle) {
      await this.playTrack(track);
    } else {
      this.queue.push(track);
      this.sync.updateQueue(this.queue);
      this.onStatusChange(`Added to queue: ${track.title}`);
    }
  }

  async playTrack(track) {
    if (!this.isHost) return;

    if (!track) {
      this.currentTrack = null;
      await this.mpv.stop();
      this.sync.updateTrack(null);
      this.onStatusChange('Queue finished.');
      return;
    }

    this.currentTrack = track;
    this.sync.updateTrack(track);
    await this._loadTrackLocally(track, 0, false);
  }

  async nextTrack() {
    if (!this.isHost) {
      this.sync.sendAction('NEXT');
      return;
    }

    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.sync.updateQueue(this.queue);
      await this.playTrack(next);
    } else {
      this.currentTrack = null;
      await this.mpv.stop();
      this.sync.updateTrack(null);
      this.onStatusChange('Queue finished.');
    }
  }

  async togglePlayPause(forcePause = null) {
    const shouldPause = forcePause !== null ? forcePause : !this.mpv.state.paused;

    if (!this.isHost) {
      this.sync.sendAction(shouldPause ? 'PAUSE' : 'PLAY', { timePos: this.mpv.state.timePos });
      return;
    }

    if (shouldPause) {
      await this.mpv.pause();
      this.sync.updatePause(this.mpv.state.timePos);
    } else {
      await this.mpv.play();
      this.sync.updatePlay(this.mpv.state.timePos);
    }
  }

  async seekRelative(offsetSeconds) {
    const target = Math.max(0, this.mpv.state.timePos + offsetSeconds);
    await this.seekAbsolute(target);
  }

  async seekAbsolute(targetSeconds) {
    if (!this.isHost) {
      this.sync.sendAction('SEEK', { timePos: targetSeconds });
      return;
    }

    await this.mpv.seek(targetSeconds);
    this.sync.updateSeek(targetSeconds);
  }

  async adjustVolume(delta) {
    const next = Math.max(0, Math.min(100, this.mpv.state.volume + delta));
    await this.mpv.setVolume(next);
  }

  async searchYouTube(query) {
    return this.youtube.search(query, 5);
  }

  async resolveVideo(urlOrId) {
    return this.youtube.getVideoInfo(urlOrId);
  }

  getState() {
    return {
      isHost: this.isHost,
      hostAddress: this.hostDisplayAddress,
      peerCount: this.peerCount,
      pingMs: this.pingMs,
      currentTrack: this.currentTrack,
      timePos: this.mpv.state.timePos,
      duration: this.mpv.state.duration,
      paused: this.mpv.state.paused,
      idle: this.mpv.state.idle,
      volume: this.mpv.state.volume,
      queue: this.queue
    };
  }

  destroy() {
    if (this.discovery) {
      this.discovery.close();
    }
    if (this.sync) {
      this.sync.destroy();
    }
    if (this.mpv) {
      this.mpv.destroy();
    }
  }
}
