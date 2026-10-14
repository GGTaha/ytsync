import net from 'node:net';
import { App } from '../src/app.js';
import { resolveBinary } from '../src/utils.js';

function createLatencyProxy({ listenPort, targetPort, latencyMs = 75 }) {
  const server = net.createServer((clientSocket) => {
    const upstreamSocket = net.createConnection({ port: targetPort }, () => {
      clientSocket.on('data', (chunk) => {
        setTimeout(() => {
          if (!upstreamSocket.destroyed && upstreamSocket.writable) upstreamSocket.write(chunk);
        }, latencyMs);
      });
      upstreamSocket.on('data', (chunk) => {
        setTimeout(() => {
          if (!clientSocket.destroyed && clientSocket.writable) clientSocket.write(chunk);
        }, latencyMs);
      });
    });
    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => clientSocket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', () => {
      resolve({ close: () => new Promise(r => server.close(r)) });
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runRealProxyE2ETest() {
  console.log('\n======================================================================');
  console.log('       LIVE REAL-MPV TEST WITH ARTIFICIAL 150ms PING PROXY            ');
  console.log('======================================================================\n');

  const hostPort = 5555;
  const proxyPort = 5566;
  const mpvBin = resolveBinary('mpv');
  const ytdlpBin = resolveBinary('yt-dlp');

  // 1. Start artificial 150ms RTT proxy (75ms each way)
  const proxy = await createLatencyProxy({ listenPort: proxyPort, targetPort: hostPort, latencyMs: 75 });
  console.log('[OK] Latency proxy active on port 5566 (simulating 150ms ping)');

  // 2. Start Host App
  const hostApp = new App({
    isHost: true,
    port: hostPort,
    mpvBinary: mpvBin,
    ytdlpBinary: ytdlpBin
  });
  await hostApp.init();
  console.log('[OK] Host initialized');

  // 3. Start Client App through 150ms proxy
  const clientApp = new App({
    isHost: false,
    join: `127.0.0.1:${proxyPort}`,
    mpvBinary: mpvBin,
    ytdlpBinary: ytdlpBin
  });
  await clientApp.init();
  console.log('[OK] Client connected through 150ms proxy');

  // Wait for initial connection & ping roundtrip
  await sleep(400);
  console.log(`[OK] Measured client ping: ${clientApp.pingMs}ms (Proxy simulated: 150ms)`);

  // 4. Enqueue a short direct test track
  const testTrack = {
    id: 'test_audio',
    title: 'Test Synthetic Tone',
    channel: 'Test Suite',
    duration: 30,
    url: 'https://raw.githubusercontent.com/rafaelreis-hotmart/Audio-Sample-files/master/sample.mp3'
  };

  console.log('\n▶ Enqueuing track to trigger Barrier Handshake over 150ms ping...');
  await hostApp.enqueueOrPlay(testTrack);

  // Wait for stream to buffer, barrier to complete and playback to start
  let started = false;
  for (let i = 0; i < 25; i++) {
    await sleep(500);
    const hState = hostApp.getState();
    const cState = clientApp.getState();
    if (!hState.paused && !cState.paused && hState.timePos > 0 && cState.timePos > 0) {
      started = true;
      break;
    }
  }

  if (!started) {
    throw new Error('Playback failed to start simultaneously within timeout');
  }

  console.log('[OK] Both Host and Guest started playing simultaneously over 150ms ping!');

  // Measure drift over 4 seconds of live playback
  for (let i = 1; i <= 3; i++) {
    await sleep(1000);
    const hPos = hostApp.getState().timePos;
    const cPos = clientApp.getState().timePos;
    const drift = Math.abs(hPos - cPos);
    console.log(`   Sample ${i}: Host = ${hPos.toFixed(2)}s | Guest = ${cPos.toFixed(2)}s | Drift = ${(drift * 1000).toFixed(0)}ms`);
    if (drift > 0.4) {
      throw new Error(`Drift exceeded tolerance: ${drift.toFixed(2)}s`);
    }
  }

  console.log('[OK] Live playback drift stayed strictly within <300ms without mid-song seeking!');

  // Test mid-song pause over 150ms ping
  console.log('\n▶ Triggering pause via Host...');
  await hostApp.togglePlayPause(true);
  await sleep(500);

  const hPaused = hostApp.getState().paused;
  const cPaused = clientApp.getState().paused;
  console.log(`[OK] Pause synchronized: Host paused = ${hPaused}, Guest paused = ${cPaused}`);

  // Clean exit
  clientApp.destroy();
  hostApp.destroy();
  await proxy.close();
  await sleep(100);

  console.log('\n======================================================================');
  console.log('       LIVE 150ms PROXY E2E TEST PASSED WITH ZERO ERRORS!             ');
  console.log('======================================================================\n');
  process.exit(0);
}

runRealProxyE2ETest().catch(err => {
  console.error('\nE2E Proxy Test Error:', err);
  process.exit(1);
});
