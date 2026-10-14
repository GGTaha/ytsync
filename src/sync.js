import net from 'node:net';
import EventEmitter from 'node:events';

/**
 * Message framing helper for newline-delimited JSON
 */
function createJsonStream(socket, onMessage) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep partial

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        onMessage(msg);
      } catch (e) {
        // invalid json
      }
    }
  });
}

function sendJson(socket, obj) {
  if (socket && !socket.destroyed && socket.writable) {
    socket.write(JSON.stringify(obj) + '\n');
  }
}

/**
 * Host / Server Sync Manager
 */
export class HostSync extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 4455;
    this.host = options.host || '0.0.0.0';
    this.server = null;
    this.peers = new Set();
    this.readyPeers = new Set();
    this.stalledPeers = new Set();
    this.peerCount = 0;

    this.state = {
      currentTrack: null,
      timePos: 0,
      duration: 0,
      paused: true,
      queue: []
    };

    this.heartbeatTimer = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.peers.add(socket);
        this.peerCount = this.peers.size;
        this.emit('peer-connected', { address: socket.remoteAddress, total: this.peerCount });

        // Send current full state immediately
        sendJson(socket, {
          type: 'ROOM_STATE',
          payload: this.state
        });

        createJsonStream(socket, (msg) => {
          this._handlePeerMessage(socket, msg);
        });

        socket.on('close', () => {
          this.peers.delete(socket);
          this.readyPeers.delete(socket);
          const wasStalled = this.stalledPeers.delete(socket);
          this.peerCount = this.peers.size;
          this.emit('peer-disconnected', { address: socket.remoteAddress, total: this.peerCount });
          if (wasStalled) {
            this.emit('peer-buffer-stall', { peerCountStalled: this.stalledPeers.size });
          }
        });

        socket.on('error', () => {
          socket.destroy();
        });
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        this._startHeartbeat();
        resolve(this.server.address());
      });
    });
  }

  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.peers.size > 0 && this.state.currentTrack) {
        this.broadcast({
          type: 'HEARTBEAT',
          payload: {
            timePos: this.state.timePos,
            paused: this.state.paused
          }
        });
      }
    }, 1000);
  }

  _handlePeerMessage(senderSocket, msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'ACTION': {
        const action = msg.action;
        const payload = msg.payload || {};
        this.emit('action', { action, payload, fromPeer: true });
        break;
      }
      case 'TRACK_READY': {
        this.readyPeers.add(senderSocket);
        this.emit('peer-ready', { peer: senderSocket, readyCount: this.readyPeers.size, totalPeers: this.peers.size });
        break;
      }
      case 'BUFFER_STALL': {
        const isStalled = msg.payload?.stalled ?? true;
        if (isStalled) {
          this.stalledPeers.add(senderSocket);
        } else {
          this.stalledPeers.delete(senderSocket);
        }
        this.emit('peer-buffer-stall', { peerCountStalled: this.stalledPeers.size });
        break;
      }
      case 'PING': {
        sendJson(senderSocket, {
          type: 'PONG',
          clientTime: msg.clientTime,
          serverTime: Date.now()
        });
        break;
      }
    }
  }

  broadcast(msg, excludeSocket = null) {
    for (const peer of this.peers) {
      if (peer !== excludeSocket) {
        sendJson(peer, msg);
      }
    }
  }

  _sanitizeTrack(track) {
    if (!track) return null;
    return {
      id: track.id,
      title: track.title,
      channel: track.channel,
      duration: track.duration,
      url: track.url
    };
  }

  updateTrack(track) {
    const cleanTrack = this._sanitizeTrack(track);
    this.state.currentTrack = cleanTrack;
    this.state.timePos = 0;
    this.state.paused = true;
    this.readyPeers.clear();
    this.broadcast({
      type: 'LOAD_TRACK',
      payload: cleanTrack
    });
  }

  startPlayback(startAt) {
    this.state.paused = false;
    this.broadcast({
      type: 'START_PLAYBACK',
      payload: { startAt }
    });
  }

  updatePlay(timePos) {
    this.state.paused = false;
    this.state.timePos = timePos;
    this.broadcast({
      type: 'PLAY',
      payload: { timePos }
    });
  }

  updatePause(timePos) {
    this.state.paused = true;
    this.state.timePos = timePos;
    this.broadcast({
      type: 'PAUSE',
      payload: { timePos }
    });
  }

  updateSeek(timePos) {
    this.state.timePos = timePos;
    this.broadcast({
      type: 'SEEK',
      payload: { timePos }
    });
  }

  updateQueue(queue) {
    const cleanQueue = (queue || []).map(t => this._sanitizeTrack(t));
    this.state.queue = cleanQueue;
    this.broadcast({
      type: 'QUEUE_UPDATE',
      payload: { queue: cleanQueue }
    });
  }

  destroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const peer of this.peers) {
      peer.destroy();
    }
    this.peers.clear();
    this.readyPeers.clear();
    this.stalledPeers.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

/**
 * Client / Peer Sync Manager
 */
export class ClientSync extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 4455;
    this.socket = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
    this.pingMs = 0;
    this.pingTimer = null;
  }

  connect() {
    this.shouldReconnect = true;
    this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.connected = true;
      this.emit('connected', { host: this.host, port: this.port });
      this._startPing();
    });

    createJsonStream(this.socket, (msg) => {
      this._handleServerMessage(msg);
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
      this.socket.destroy();
    });
  }

  _startPing() {
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        sendJson(this.socket, {
          type: 'PING',
          clientTime: Date.now()
        });
      }
    }, 5000);
  }

  _handleServerMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'ROOM_STATE':
        this.emit('room-state', msg.payload);
        break;
      case 'LOAD_TRACK':
        this.emit('load-track', msg.payload);
        break;
      case 'START_PLAYBACK':
        this.emit('start-playback', msg.payload);
        break;
      case 'PLAY':
        this.emit('play', msg.payload);
        break;
      case 'PAUSE':
        this.emit('pause', msg.payload);
        break;
      case 'SEEK':
        this.emit('seek', msg.payload);
        break;
      case 'QUEUE_UPDATE':
        this.emit('queue-update', msg.payload.queue);
        break;
      case 'HEARTBEAT':
        this.emit('heartbeat', msg.payload);
        break;
      case 'PONG': {
        const rtt = Date.now() - msg.clientTime;
        this.pingMs = rtt;
        this.emit('ping', rtt);
        break;
      }
    }
  }

  sendTrackReady() {
    if (this.connected) {
      sendJson(this.socket, { type: 'TRACK_READY' });
    }
  }

  sendBufferStall(stalled) {
    if (this.connected) {
      sendJson(this.socket, { type: 'BUFFER_STALL', payload: { stalled } });
    }
  }

  sendAction(action, payload = {}) {
    if (this.connected) {
      sendJson(this.socket, {
        type: 'ACTION',
        action,
        payload
      });
    }
  }

  destroy() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }
}
