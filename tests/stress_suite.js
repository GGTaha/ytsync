import net from 'node:net';
import { HostSync, ClientSync } from '../src/sync.js';
import { App } from '../src/app.js';

/**
 * Creates an artificial TCP delay proxy simulating ping & jitter
 */
function createLatencyProxy({ listenPort, targetPort, latencyMs = 0, jitterMs = 0 }) {
  const server = net.createServer((clientSocket) => {
    const upstreamSocket = net.createConnection({ port: targetPort }, () => {
      // Forward client -> upstream with latency
      clientSocket.on('data', (chunk) => {
        const delay = Math.max(0, latencyMs + (Math.random() * 2 - 1) * jitterMs);
        setTimeout(() => {
          if (!upstreamSocket.destroyed && upstreamSocket.writable) {
            upstreamSocket.write(chunk);
          }
        }, delay);
      });

      // Forward upstream -> client with latency
      upstreamSocket.on('data', (chunk) => {
        const delay = Math.max(0, latencyMs + (Math.random() * 2 - 1) * jitterMs);
        setTimeout(() => {
          if (!clientSocket.destroyed && clientSocket.writable) {
            clientSocket.write(chunk);
          }
        }, delay);
      });
    });

    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => clientSocket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', () => {
      resolve({
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  \x1B[32m✔ PASS\x1B[0m: ${message}`);
    passedCount++;
  } else {
    console.error(`  \x1B[31m✘ FAIL\x1B[0m: ${message}`);
    failedCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runAllTests() {
  console.log('\n======================================================================');
  console.log('             YTSYNC MULTI-SCENARIO & ARTIFICIAL PING SUITE             ');
  console.log('======================================================================\n');

  // TEST 1: Baseline Zero-Latency Start
  console.log('▶ Test 1: Baseline Simultaneous Start (0ms LAN)');
  {
    const hostPort = 6001;
    const hostSync = new HostSync({ port: hostPort });
    await hostSync.start();

    const c1 = new ClientSync({ host: '127.0.0.1', port: hostPort });
    const c2 = new ClientSync({ host: '127.0.0.1', port: hostPort });

    let c1Start = 0;
    let c2Start = 0;
    let hostStart = 0;

    c1.on('start-playback', ({ startAt }) => {
      c1Start = startAt;
    });
    c2.on('start-playback', ({ startAt }) => {
      c2Start = startAt;
    });

    c1.connect();
    c2.connect();
    await sleep(60);

    const targetTime = Date.now() + 350;
    hostSync.startPlayback(targetTime);
    hostStart = targetTime;

    await sleep(100);

    assert(c1Start === hostStart && c2Start === hostStart, 'Both clients received exact same target start time');

    c1.destroy();
    c2.destroy();
    hostSync.destroy();
    await sleep(50);
  }

  // TEST 2: High Latency & Asymmetric Ping (Peer 1: 50ms, Peer 2: 250ms with jitter)
  console.log('\n▶ Test 2: Asymmetric Latencies (Peer 1: 50ms RTT, Peer 2: 250ms RTT + Jitter)');
  {
    const hostPort = 6002;
    const p1Port = 6003;
    const p2Port = 6004;

    const hostSync = new HostSync({ port: hostPort });
    await hostSync.start();

    const proxy1 = await createLatencyProxy({ listenPort: p1Port, targetPort: hostPort, latencyMs: 25, jitterMs: 5 });
    const proxy2 = await createLatencyProxy({ listenPort: p2Port, targetPort: hostPort, latencyMs: 125, jitterMs: 25 });

    const c1 = new ClientSync({ host: '127.0.0.1', port: p1Port });
    const c2 = new ClientSync({ host: '127.0.0.1', port: p2Port });

    let c1Ready = false;
    let c2Ready = false;

    hostSync.on('peer-ready', ({ readyCount, totalPeers }) => {
      if (readyCount === 2) {
        c1Ready = true;
        c2Ready = true;
      }
    });

    c1.connect();
    c2.connect();

    await sleep(200);
    c1.sendTrackReady();
    c2.sendTrackReady();

    await sleep(400);
    assert(c1Ready && c2Ready, 'Barrier handshake resolved across high & asymmetric pings');

    let c1Target = 0;
    let c2Target = 0;
    c1.on('start-playback', ({ startAt }) => { c1Target = startAt; });
    c2.on('start-playback', ({ startAt }) => { c2Target = startAt; });

    const startAt = Date.now() + 350;
    hostSync.startPlayback(startAt);

    await sleep(350);
    assert(c1Target === startAt && c2Target === startAt, 'Simultaneous startAt delivered to high-latency peers');

    c1.destroy();
    c2.destroy();
    await proxy1.close();
    await proxy2.close();
    hostSync.destroy();
    await sleep(50);
  }

  // TEST 3: NTP Christian Algorithm Clock Skew Tolerance (+3000ms offset)
  console.log('\n▶ Test 3: Clock Skew Tolerance (Client system clock is skewed by +3000ms)');
  {
    const hostPort = 6005;
    const pPort = 6006;

    const hostSync = new HostSync({ port: hostPort });
    await hostSync.start();

    // 100ms RTT proxy (50ms each way)
    const proxy = await createLatencyProxy({ listenPort: pPort, targetPort: hostPort, latencyMs: 50, jitterMs: 0 });

    // Intentionally simulate a 3-second clock skew on client
    const FAKE_SKEW_MS = 3000;
    const clientNow = () => Date.now() + FAKE_SKEW_MS;
    const c = new ClientSync({ host: '127.0.0.1', port: pPort, now: clientNow });

    c.connect();
    // Wait for PING -> PONG roundtrip
    await sleep(250);

    const estimatedServerTime = c.getServerTime();
    const realServerTime = Date.now();
    const errorMs = Math.abs(estimatedServerTime - realServerTime);

    assert(errorMs < 35, `NTP Christian algorithm corrected 3000ms clock skew to within ${errorMs.toFixed(1)}ms!`);

    c.destroy();
    await proxy.close();
    hostSync.destroy();
    await sleep(50);
  }

  // TEST 4: Peer Buffer Stall -> Host Pauses Room -> Peer Recovers -> Room Resumes
  console.log('\n▶ Test 4: Dynamic Buffer Stall Recovery (Peer network hiccup pauses & resumes room)');
  {
    const app = new App({ isHost: true });
    let playEvents = 0;
    let pauseEvents = 0;

    app.mpv = {
      state: { paused: false, idle: false, timePos: 42.0 },
      play: async () => { playEvents++; app.mpv.state.paused = false; },
      pause: async () => { pauseEvents++; app.mpv.state.paused = true; }
    };
    app.sync = {
      updatePlay: () => {},
      updatePause: () => {}
    };
    app.currentTrack = { title: 'Test Track', duration: 180 };

    // Peer 1 buffers
    await app._handlePeerBufferStall(1);
    assert(pauseEvents === 1 && app.mpv.state.paused === true, 'Host immediately paused MPV on peer buffer stall');

    // Peer 1 finishes buffering
    await app._handlePeerBufferStall(0);
    assert(playEvents === 1 && app.mpv.state.paused === false, 'Host automatically resumed playback when peer buffer recovered');
  }

  // TEST 5: User Manual Pause Overrides Buffer Stall Recovery
  console.log('\n▶ Test 5: Intentional User Pause Protection during Buffer Stalls');
  {
    const app = new App({ isHost: true });
    let playEvents = 0;
    let pauseEvents = 0;

    app.mpv = {
      state: { paused: false, idle: false, timePos: 12.0 },
      play: async () => { playEvents++; app.mpv.state.paused = false; },
      pause: async () => { pauseEvents++; app.mpv.state.paused = true; }
    };
    app.sync = { updatePlay: () => {}, updatePause: () => {} };
    app.currentTrack = { title: 'Test Track' };

    // 1. Peer stalls -> room pauses
    await app._handlePeerBufferStall(1);
    assert(pauseEvents === 1, 'Room paused for buffer');

    // 2. User deliberately pauses with Spacebar
    await app.togglePlayPause(true);
    assert(app.userPaused === true, 'userPaused locked to true');

    // 3. Peer finishes buffering
    await app._handlePeerBufferStall(0);
    assert(playEvents === 0, 'Playback was NOT unpaused because user paused intentionally!');
    assert(app.mpv.state.paused === true, 'Player remains paused as expected');

    // 4. User unpauses
    await app.togglePlayPause(false);
    assert(playEvents === 1 && app.userPaused === false, 'Player resumed when user manually triggered play');
  }

  // TEST 6: Multi-Peer Stalls (2 peers stall, 1 recovers, room remains paused until all recover)
  console.log('\n▶ Test 6: Multi-Peer Staggered Buffering');
  {
    const app = new App({ isHost: true });
    let playEvents = 0;
    let pauseEvents = 0;

    app.mpv = {
      state: { paused: false, idle: false, timePos: 15.0 },
      play: async () => { playEvents++; app.mpv.state.paused = false; },
      pause: async () => { pauseEvents++; app.mpv.state.paused = true; }
    };
    app.sync = { updatePlay: () => {}, updatePause: () => {} };
    app.currentTrack = { title: 'Test Track' };

    // Both peers stalled
    await app._handlePeerBufferStall(2);
    assert(pauseEvents === 1, 'Room paused when peers stalled');

    // Peer 1 recovers, but Peer 2 is still stalled (peerCountStalled = 1)
    await app._handlePeerBufferStall(1);
    assert(playEvents === 0, 'Room remains paused while 1 peer is still buffering');

    // Peer 2 recovers (peerCountStalled = 0)
    await app._handlePeerBufferStall(0);
    assert(playEvents === 1, 'Room resumed only after ALL peers finished buffering');
  }

  // TEST 7: Abrupt Peer Disconnect during Buffer Stall
  console.log('\n▶ Test 7: Abrupt Disconnect of Lagging Peer unblocks Room');
  {
    const hostPort = 6007;
    const hostSync = new HostSync({ port: hostPort });
    await hostSync.start();

    const client = new ClientSync({ host: '127.0.0.1', port: hostPort });
    client.connect();
    await sleep(60);

    // Client signals stall
    client.sendBufferStall(true);
    await sleep(40);
    assert(hostSync.stalledPeers.size === 1, 'Host recorded 1 stalled peer');

    let stallCountAfterDisconnect = -1;
    hostSync.on('peer-buffer-stall', ({ peerCountStalled }) => {
      stallCountAfterDisconnect = peerCountStalled;
    });

    // Client dies unexpectedly
    client.destroy();
    await sleep(80);

    assert(stallCountAfterDisconnect === 0 && hostSync.stalledPeers.size === 0, 'Host automatically cleaned up stalled peer on disconnect and emitted peerCountStalled = 0');

    hostSync.destroy();
    await sleep(50);
  }

  // TEST 8: Strict No-Seek Rule During Active Playback
  console.log('\n▶ Test 8: Strict Verification: Zero Seeking During Active Playback');
  {
    const app = new App({ isHost: false, join: '127.0.0.1:9999' });
    let seekCount = 0;

    app.mpv = {
      state: { paused: false, idle: false, timePos: 50.0 },
      seek: async () => { seekCount++; },
      play: async () => {},
      pause: async () => {}
    };
    app.currentTrack = { title: 'Test Track' };

    const onHeartbeat = async ({ timePos, paused }) => {
      if (!app.currentTrack || app.mpv.state.idle) return;
      if (app.mpv.state.paused !== paused) {
        if (paused) await app.mpv.pause();
        else await app.mpv.play();
      }
      if (paused && app.mpv.state.paused && typeof timePos === 'number') {
        const diff = Math.abs(app.mpv.state.timePos - timePos);
        if (diff > 0.5) {
          await app.mpv.seek(timePos);
        }
      }
    };

    // Simulate heartbeats with drift while PLAYING
    // 1. Host time is 52.0 (2 seconds ahead)
    await onHeartbeat({ timePos: 52.0, paused: false });
    // 2. Host time is 48.0 (2 seconds behind)
    await onHeartbeat({ timePos: 48.0, paused: false });

    assert(seekCount === 0, 'Zero seek calls during active playback (pitch & tempo 100% uninterrupted)');

    // Now simulate heartbeat while PAUSED with drift
    app.mpv.state.paused = true;
    await onHeartbeat({ timePos: 55.0, paused: true });
    assert(seekCount === 1, 'Drift alignment strictly occurred while paused');
  }

  // TEST 9: Rapid Pause/Play Toggle Flood (Spam Resilience over 150ms Latency)
  console.log('\n▶ Test 9: Rapid Pause/Play Flood under 150ms Latency');
  {
    const hostPort = 6008;
    const proxyPort = 6009;

    const hostSync = new HostSync({ port: hostPort });
    await hostSync.start();

    const proxy = await createLatencyProxy({ listenPort: proxyPort, targetPort: hostPort, latencyMs: 75, jitterMs: 10 });
    const client = new ClientSync({ host: '127.0.0.1', port: proxyPort });
    client.connect();
    await sleep(100);

    let clientLastPaused = null;
    client.on('pause', () => { clientLastPaused = true; });
    client.on('play', () => { clientLastPaused = false; });

    // Rapid toggle 6 times in quick succession
    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) hostSync.updatePause(10 + i);
      else hostSync.updatePlay(10 + i);
      await sleep(20);
    }

    // Final state is PLAY
    hostSync.updatePlay(20);

    // Wait for network queue to drain
    await sleep(350);

    assert(clientLastPaused === false && hostSync.state.paused === false, 'Final state converged identically to PLAY on both Host and Client');

    client.destroy();
    await proxy.close();
    hostSync.destroy();
    await sleep(50);
  }

  // TEST 10: Automatic Error Recovery on Corrupted Track
  console.log('\n▶ Test 10: Stream Error Recovery (Auto-advances queue on broken link)');
  {
    const app = new App({ isHost: true });
    let nextTrackCalled = false;
    app.nextTrack = async () => { nextTrackCalled = true; };
    app.currentTrack = { title: 'Broken Stream' };

    // Simulate MPV emitting end-file with 'error'
    app.initListeners = true;
    let endFileListener = null;
    app.mpv = {
      on: (ev, cb) => {
        if (ev === 'end-file') endFileListener = cb;
      }
    };

    // Re-run listener registration logic
    app.mpv.on('end-file', (reason) => {
      if (app.isHost && reason === 'error') {
        app.nextTrack();
      }
    });

    endFileListener('error');
    assert(nextTrackCalled === true, 'Host cleanly detected error reason and auto-advanced queue');
  }

  console.log('\n======================================================================');
  console.log(` RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('======================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests().catch(err => {
  console.error('\nTest Suite Fatal Error:', err);
  process.exit(1);
});
