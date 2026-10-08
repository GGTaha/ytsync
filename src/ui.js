import readline from 'node:readline';
import { getClipboard } from './utils.js';

export class TerminalUI {
  constructor(app) {
    this.app = app;
    this.view = 'NORMAL'; // 'NORMAL' | 'INPUT' | 'RESULTS'
    this.inputBuffer = '';
    this.searchResults = [];
    this.renderInterval = null;
    this.statusMessage = '';
    this.statusTimeout = null;
  }

  start() {
    process.stdout.write('\x1B[?25l'); // Hide cursor
    process.stdout.write('\x1B[2J\x1B[H'); // Clear entire screen

    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();

      process.stdin.on('keypress', (str, key) => {
        this._handleKeypress(str, key);
      });
    }

    this.renderInterval = setInterval(() => {
      this.render();
    }, 150);

    process.on('SIGINT', () => this.cleanup(true));
    process.on('SIGTERM', () => this.cleanup(true));
    process.on('SIGHUP', () => this.cleanup(true));
    process.on('exit', () => this.cleanup(false));
  }

  setStatus(msg, duration = 3000) {
    this.statusMessage = msg;
    if (this.statusTimeout) clearTimeout(this.statusTimeout);
    this.statusTimeout = setTimeout(() => {
      this.statusMessage = '';
    }, duration);
  }

  resetInput() {
    this.view = 'NORMAL';
    this.inputBuffer = '';
    this.searchResults = [];
  }

  _formatTime(seconds) {
    if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  _progressBar(current, total, width = 30) {
    if (!total || total <= 0) return '─'.repeat(width);
    const ratio = Math.min(1, Math.max(0, current / total));
    const filled = Math.round(ratio * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  render() {
    const { isHost, currentTrack, timePos, duration, paused, idle, volume, queue, peerCount, pingMs, hostAddress } = this.app.getState();

    let out = '\x1B[H'; // Move to top-left

    out += '\x1B[36m╔══════════════════════════════════════════════════════════════════════╗\x1B[0m\x1B[K\n';
    out += '\x1B[36m║\x1B[0m \x1B[1m\x1B[33m                   🎵 YTSYNC TERMINAL MUSIC PLAYER                  \x1B[0m \x1B[36m║\x1B[0m\x1B[K\n';
    out += '\x1B[36m╚══════════════════════════════════════════════════════════════════════╝\x1B[0m\x1B[K\n';

    // Room info
    if (isHost) {
      out += ` \x1B[1mRole:\x1B[0m \x1B[32mHOST\x1B[0m (${hostAddress || 'Port 4455'})  │  \x1B[1mConnected Peers:\x1B[0m \x1B[33m${peerCount}\x1B[0m\x1B[K\n`;
    } else {
      out += ` \x1B[1mRole:\x1B[0m \x1B[34mGUEST\x1B[0m (${hostAddress})  │  \x1B[1mPing:\x1B[0m \x1B[33m${pingMs}ms\x1B[0m\x1B[K\n`;
    }
    out += '\x1B[90m────────────────────────────────────────────────────────────────────────\x1B[0m\x1B[K\n';

    // Now Playing section
    if (currentTrack) {
      const statusIcon = paused ? '\x1B[33m⏸ PAUSED\x1B[0m' : idle ? '\x1B[36m⏳ BUFFERING\x1B[0m' : '\x1B[32m▶ PLAYING\x1B[0m';
      const title = currentTrack.title.length > 55 ? currentTrack.title.slice(0, 52) + '...' : currentTrack.title;
      const channel = currentTrack.channel ? (currentTrack.channel.length > 40 ? currentTrack.channel.slice(0, 37) + '...' : currentTrack.channel) : 'YouTube';

      out += ` \x1B[1mNow Playing:\x1B[0m \x1B[1m\x1B[37m${title}\x1B[0m\x1B[K\n`;
      out += ` \x1B[1mArtist/Chan:\x1B[0m \x1B[90m${channel}\x1B[0m\x1B[K\n`;
      out += ` \x1B[1mState:\x1B[0m       ${statusIcon}\x1B[K\n`;

      const bar = this._progressBar(timePos, duration, 32);
      const timeStr = `${this._formatTime(timePos)} / ${this._formatTime(duration)}`;
      out += ` \x1B[1mTime:\x1B[0m        [${bar}] ${timeStr}\x1B[K\n`;
    } else {
      out += ' \x1B[90mNo track currently playing. Press [s] to search or paste a URL.\x1B[0m\x1B[K\n';
      out += '\x1B[K\n\x1B[K\n\x1B[K\n';
    }

    out += ` \x1B[1mVolume:\x1B[0m      [${this._progressBar(volume, 100, 10)}] ${volume}%\x1B[K\n`;
    out += '\x1B[90m────────────────────────────────────────────────────────────────────────\x1B[0m\x1B[K\n';

    // Dynamic middle section based on mode
    if (this.view === 'INPUT') {
      out += ' \x1B[1m\x1B[36m🔍 Search Song or Paste YouTube URL:\x1B[0m\x1B[K\n';
      const displayBuffer = this.inputBuffer.length > 55 ? '...' + this.inputBuffer.slice(-52) : this.inputBuffer;
      out += `   \x1B[7m ${displayBuffer} \x1B[0m\x1B[36m█\x1B[0m\x1B[K\n`;
      out += '   \x1B[90m(Type query or paste URL / Ctrl+V. [Enter] submit, [Esc] cancel)\x1B[0m\x1B[K\n';
    } else if (this.view === 'RESULTS') {
      out += ' \x1B[1m\x1B[32mSelect Track to Play:\x1B[0m\x1B[K\n';
      this.searchResults.slice(0, 5).forEach((item, idx) => {
        const itemTitle = item.title.length > 45 ? item.title.slice(0, 42) + '...' : item.title;
        out += `   \x1B[33m[${idx + 1}]\x1B[0m \x1B[37m${itemTitle}\x1B[0m \x1B[90m(${this._formatTime(item.duration)})\x1B[0m\x1B[K\n`;
      });
      out += '   \x1B[90m(Press [1-5] to select, [Esc] to cancel)\x1B[0m\x1B[K\n';
    } else {
      out += ' \x1B[1mUp Next in Queue:\x1B[0m\x1B[K\n';
      if (!queue || queue.length === 0) {
        out += '   \x1B[90m(Queue is empty)\x1B[0m\x1B[K\n';
      } else {
        queue.slice(0, 3).forEach((item, idx) => {
          const itemTitle = item.title.length > 45 ? item.title.slice(0, 42) + '...' : item.title;
          out += `   ${idx + 1}. \x1B[37m${itemTitle}\x1B[0m \x1B[90m(${this._formatTime(item.duration)})\x1B[0m\x1B[K\n`;
        });
        if (queue.length > 3) {
          out += `   \x1B[90m... and ${queue.length - 3} more\x1B[0m\x1B[K\n`;
        }
      }
    }

    out += '\x1B[90m────────────────────────────────────────────────────────────────────────\x1B[0m\x1B[K\n';
    out += ' \x1B[1mControls:\x1B[0m [Space] Play/Pause  [←/→] ±5s  [s] Search/URL  [n] Next  [+/-] Vol  [q] Quit\x1B[K\n';

    if (this.statusMessage) {
      out += ` \x1B[33mℹ ${this.statusMessage}\x1B[0m\x1B[K\n`;
    } else {
      out += '\x1B[K\n';
    }

    // Clear any extra lines below this frame
    out += '\x1B[J';

    process.stdout.write(out);
  }

  async _handleKeypress(str, key) {
    if (!key && !str) return;

    // Ctrl+C ALWAYS exits cleanly
    if (key && key.ctrl && key.name === 'c') {
      this.cleanup(true);
      return;
    }

    // Branch strictly based on active view mode
    if (this.view === 'INPUT') {
      await this._handleInputKeypress(str, key);
      return;
    }

    if (this.view === 'RESULTS') {
      await this._handleResultsKeypress(str, key);
      return;
    }

    // NORMAL mode
    await this._handleNormalKeypress(str, key);
  }

  async _handleInputKeypress(str, key) {
    const name = key ? key.name : '';

    // Cancel input with Escape
    if (name === 'escape') {
      this.resetInput();
      this.setStatus('Search cancelled.');
      return;
    }

    // Enter submits input
    if (name === 'return' || str === '\r' || str === '\n') {
      const query = this.inputBuffer.trim();
      if (!query) {
        this.resetInput();
        return;
      }

      // 1. Direct URL or Video ID check
      if (this.app.youtube.isUrlOrId(query)) {
        this.resetInput();
        const url = this.app.youtube.toWatchUrl(query);
        const id = this.app.youtube.extractVideoId(query) || 'custom';
        const track = {
          id,
          title: `YouTube (${id})`,
          channel: 'YouTube',
          duration: 0,
          url: url
        };
        await this.app.enqueueOrPlay(track);
        return;
      }

      // 2. Search query
      this.setStatus(`Searching for "${query}"...`);
      this.inputBuffer = '';
      try {
        const results = await this.app.searchYouTube(query);
        if (!results || results.length === 0) {
          this.setStatus('No results found.');
          this.resetInput();
        } else {
          this.searchResults = results;
          this.view = 'RESULTS';
        }
      } catch (err) {
        this.setStatus(`Search error: ${err.message}`);
        this.resetInput();
      }
      return;
    }

    // Backspace
    if (name === 'backspace' || name === 'delete' || str === '\x08' || str === '\x7f') {
      if (this.inputBuffer.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
      }
      return;
    }

    // Ctrl+V paste support (reads Windows clipboard)
    if ((key && key.ctrl && key.name === 'v') || str === '\x16') {
      const clipboardText = getClipboard();
      if (clipboardText) {
        const clean = clipboardText.replace(/[\x00-\x1F\x7F]/g, '');
        this.inputBuffer += clean;
        this.setStatus('Pasted from clipboard');
      }
      return;
    }

    // Standard character input (typing or native terminal paste)
    // NOTE: Letters 's', 'a', 'q', etc. are just normal text here!
    if (str) {
      const clean = str.replace(/[\x00-\x1F\x7F]/g, '');
      if (clean.length > 0) {
        this.inputBuffer += clean;
      }
    }
  }

  async _handleResultsKeypress(str, key) {
    const name = key ? key.name : '';

    if (name === 'escape' || name === 's') {
      this.resetInput();
      this.setStatus('Cancelled selection.');
      return;
    }

    if (str && /^[1-5]$/.test(str)) {
      const index = parseInt(str, 10) - 1;
      if (index >= 0 && index < this.searchResults.length) {
        const selected = this.searchResults[index];
        this.resetInput();
        this.setStatus(`Selected: ${selected.title}`);
        await this.app.enqueueOrPlay(selected);
      }
    }
  }

  async _handleNormalKeypress(str, key) {
    const name = key ? key.name : '';

    if (name === 'q' || str === 'q') {
      this.cleanup(true);
      return;
    }

    if (name === 's' || str === 's' || name === 'a' || str === 'a' || str === '/') {
      this.view = 'INPUT';
      this.inputBuffer = '';
      this.searchResults = [];
      return;
    }

    if (name === 'space' || str === ' ') {
      this.setStatus('Play/Pause toggled');
      await this.app.togglePlayPause();
    } else if (name === 'left') {
      this.setStatus('Seek -5s');
      await this.app.seekRelative(-5);
    } else if (name === 'right') {
      this.setStatus('Seek +5s');
      await this.app.seekRelative(5);
    } else if (name === 'n' || str === 'n') {
      this.setStatus('Next track...');
      await this.app.nextTrack();
    } else if (str === '+' || str === '=' || name === 'up') {
      await this.app.adjustVolume(5);
    } else if (str === '-' || str === '_' || name === 'down') {
      await this.app.adjustVolume(-5);
    }
  }

  cleanup(shouldExit = true) {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    process.stdout.write('\x1B[?25h'); // Restore cursor
    process.stdout.write('\x1B[0m\n');
    if (this.app) {
      this.app.destroy();
    }
    if (shouldExit) {
      process.exit(0);
    }
  }
}
