import { App } from '../src/app.js';
import { resolveBinary } from '../src/utils.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testLateJoiner() {
  console.log('\n======================================================================');
  console.log('                 LATE-JOINER SYNCHRONIZATION TEST                     ');
  console.log('======================================================================\n');

  const mpvBin = resolveBinary('mpv');
  const ytdlpBin = resolveBinary('yt-dlp');
  const port = 5577;

  // 1. Host starts alone
  const hostApp = new App({
    isHost: true,
    port: port,
    mpvBinary: mpvBin,
    ytdlpBinary: ytdlpBin
  });
  await hostApp.init();
  console.log('[OK] Host started');

  const testTrack = {
    id: 'test_late',
    title: 'Late Join Sample',
    channel: 'Test Suite',
    duration: 30,
    url: 'https://raw.githubusercontent.com/rafaelreis-hotmart/Audio-Sample-files/master/sample.mp3'
  };

  // 2. Host starts playing track before client connects
  await hostApp.enqueueOrPlay(testTrack);

  // Wait for host to start playing and reach ~3 seconds
  let hostPlaying = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const state = hostApp.getState();
    if (!state.paused && state.timePos >= 2.0) {
      hostPlaying = true;
      break;
    }
  }

  if (!hostPlaying) {
    throw new Error('Host failed to reach target playback position');
  }

  const hostPosBeforeJoin = hostApp.getState().timePos;
  console.log(`[OK] Host is playing at position: ${hostPosBeforeJoin.toFixed(2)}s`);

  // 3. Client joins while song is mid-way
  console.log('\n▶ Client joining room late...');
  const clientApp = new App({
    isHost: false,
    join: `127.0.0.1:${port}`,
    mpvBinary: mpvBin,
    ytdlpBinary: ytdlpBin
  });
  await clientApp.init();

  // Wait for client to receive room-state, buffer track, and align
  let clientAligned = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const cState = clientApp.getState();
    if (cState.currentTrack && cState.timePos >= 2.0) {
      clientAligned = true;
      break;
    }
  }

  const hostPosAfter = hostApp.getState().timePos;
  const clientPosAfter = clientApp.getState().timePos;
  console.log(`   Host Position   = ${hostPosAfter.toFixed(2)}s`);
  console.log(`   Client Position = ${clientPosAfter.toFixed(2)}s`);
  const drift = Math.abs(hostPosAfter - clientPosAfter);
  console.log(`   Alignment Delta = ${(drift * 1000).toFixed(0)}ms`);

  if (!clientAligned || drift > 1.5) {
    throw new Error(`Late joiner failed to align: drift = ${drift.toFixed(2)}s`);
  }

  console.log('[OK] Late joiner successfully synchronized with active session!');

  clientApp.destroy();
  hostApp.destroy();
  await sleep(100);
  console.log('\n======================================================================');
  console.log('              LATE-JOINER TEST PASSED SUCCESSFULLY!                   ');
  console.log('======================================================================\n');
  process.exit(0);
}

testLateJoiner().catch(err => {
  console.error('\nLate Joiner Test Failed:', err);
  process.exit(1);
});
