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
    this.hostReady = false;
    this.startPlaybackTimeout = null;
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

    this.mpv.on('paused-for-cache', async (isStalled) => {
      await this._handleBufferStateChange(isStalled);
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
      this.sync.on('peer-ready', () => {
        this._checkAllPeersReady();
      });
      this.sync.on('peer-buffer-stall', async ({ stalled }) => {
        await this._handlePeerBufferStall(stalled);
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
          await this._loadTrackLocally(state.currentTrack, state.timePos);
        }
      });

      this.sync.on('load-track', async (track) => {
        await this._loadTrackLocally(track, 0);
      });

      this.sync.on('start-playback', async ({ startAt }) => {
        const delay = Math.max(0, (startAt || Date.now()) - Date.now());
        setTimeout(async () => {
          this._suppressSyncBroadcast = true;
          await this.mpv.play();
          this._suppressSyncBroadcast = false;
          this.onStatusChange(`Playing: ${this.currentTrack?.title || ''}`);
        }, delay);
      });

      this.sync.on('play', async () => {
        this._suppressSyncBroadcast = true;
        await this.mpv.play();
        this._suppressSyncBroadcast = false;
        this.onStatusChange(`Playing: ${this.currentTrack?.title || ''}`);
      });

      this.sync.on('pause', async ({ timePos }) => {
        this._suppressSyncBroadcast = true;
        await this.mpv.pause();
        if (typeof timePos === 'number' && Math.abs(this.mpv.state.timePos - timePos) > 0.5) {
          await this.mpv.seek(timePos);
        }
        this._suppressSyncBroadcast = false;
        this.onStatusChange(`Paused: ${this.currentTrack?.title || ''}`);
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

        // 1. Align pause states
        if (this.mpv.state.paused !== paused) {
          if (paused) await this.mpv.pause();
          else await this.mpv.play();
        }

        // 2. STRICT NO-SEEK RULE DURING ACTIVE PLAYBACK:
        // Position alignment ONLY happens while PAUSED!
        // Never seek, skip, speed up, or slow down during active playback!
        if (paused && this.mpv.state.paused && typeof timePos === 'number') {
          const diff = Math.abs(this.mpv.state.timePos - timePos);
          if (diff > 0.5) {
            await this.mpv.seek(timePos);
          }
        }
      });

      this.sync.connect();
    }
  }

  async _loadTrackLocally(track, startPos = 0) {
    if (!track) {
      this.currentTrack = null;
      await this.mpv.stop();
      this.onStatusChange('Queue finished.');
      return;
    }

    this.currentTrack = track;
    this.lastTrackLoadTime = Date.now();
    this.onStatusChange(`Resolving stream: ${track.title}...`);

    try {
      const target = track.url || (track.id ? `https://www.youtube.com/watch?v=${track.id}` : null);
      if (!target) return;

      // 1. Resolve local audio stream URL
      const streamUrl = await this.youtube.getAudioStreamUrl(target);

      this.onStatusChange(`Buffering: ${track.title}...`);

      // 2. Pause MPV before loading so it pre-buffers into RAM without playing yet
      await this.mpv.pause();

      // 3. Load direct stream
      await this.mpv.loadFile(streamUrl);

      // 4. Wait for MPV to finish demuxing headers and duration
      await this.mpv.waitUntilLoaded(14000);

      if (startPos > 0) {
        await this.mpv.seek(startPos);
      }

      // 5. Signal readiness
      if (this.isHost) {
        this.hostReady = true;
        this.onStatusChange(`Buffered: ${track.title}`);
        this._checkAllPeersReady();
      } else {
        this.sync.sendTrackReady();
        this.onStatusChange(`Buffered. Syncing start with host...`);
      }
    } catch (err) {
      this.onStatusChange(`Playback error: ${err.message}`);
    }
  }

  _checkAllPeersReady() {
    if (!this.isHost || !this.hostReady) return;

    const totalPeers = this.sync.peers.size;
    const readyCount = this.sync.readyPeers.size;

    if (readyCount >= totalPeers) {
      this._releasePlayback();
    } else {
      this.onStatusChange(`Waiting for peers to buffer (${readyCount}/${totalPeers})...`);
      if (this.startPlaybackTimeout) clearTimeout(this.startPlaybackTimeout);
      this.startPlaybackTimeout = setTimeout(() => {
        if (this.currentTrack && this.mpv.state.paused) {
          this._releasePlayback();
        }
      }, 8000);
    }
  }

  _releasePlayback() {
    if (this.startPlaybackTimeout) clearTimeout(this.startPlaybackTimeout);
    this.startPlaybackTimeout = null;

    const startAt = Date.now() + 250;
    this.sync.startPlayback(startAt);

    setTimeout(async () => {
      await this.mpv.play();
      this.onStatusChange(`Playing: ${this.currentTrack?.title || ''}`);
    }, 250);
  }

  async _handleBufferStateChange(isStalled) {
    if (!this.currentTrack || this.mpv.state.idle) return;

    if (isStalled) {
      if (this.isHost) {
        await this.togglePlayPause(true);
        this.onStatusChange('Buffering audio stream (paused)...');
      } else {
        this.sync.sendBufferStall(true);
        this.onStatusChange('Buffering audio stream...');
      }
    } else {
      if (this.isHost) {
        await this.togglePlayPause(false);
        this.onStatusChange(`Playing: ${this.currentTrack?.title || ''}`);
      } else {
        this.sync.sendBufferStall(false);
        this.onStatusChange('Buffer ready.');
      }
    }
  }

  async _handlePeerBufferStall(stalled) {
    if (!this.isHost || !this.currentTrack) return;
    if (stalled) {
      await this.togglePlayPause(true);
      this.onStatusChange('Peer is buffering stream (paused)...');
    } else {
      await this.togglePlayPause(false);
      this.onStatusChange(`Playing: ${this.currentTrack?.title || ''}`);
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
    this.hostReady = false;
    this.sync.updateTrack(track);
    await this._loadTrackLocally(track, 0);
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
      pausedForCache: this.mpv.state.pausedForCache,
      volume: this.mpv.state.volume,
      queue: this.queue
    };
  }

  destroy() {
    if (this.startPlaybackTimeout) {
      clearTimeout(this.startPlaybackTimeout);
      this.startPlaybackTimeout = null;
    }
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
