import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class YouTubeService {
  constructor(options = {}) {
    this.ytdlpBinary = options.ytdlpBinary || 'yt-dlp';
  }

  /**
   * Checks whether input is a YouTube URL or standalone 11-char video ID
   */
  isUrlOrId(input) {
    if (!input || typeof input !== 'string') return false;
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) return true;
    if (/^youtu\.be\//i.test(trimmed)) return true;
    if (/^www\.youtube\.com\//i.test(trimmed)) return true;
    if (/^[\w-]{11}$/.test(trimmed)) return true;
    return false;
  }

  /**
   * Search YouTube or return direct video info if a URL was passed
   * @param {string} query
   * @param {number} limit
   */
  async search(query, limit = 5) {
    const trimmed = query.trim();
    if (this.isUrlOrId(trimmed)) {
      const info = await this.getVideoInfo(trimmed);
      return [info];
    }

    const searchTarget = `ytsearch${limit}:${trimmed}`;
    const args = [
      searchTarget,
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors'
    ];

    try {
      const { stdout } = await execFileAsync(this.ytdlpBinary, args, {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });

      const lines = stdout.trim().split('\n');
      const results = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          results.push({
            id: item.id,
            title: item.title || 'Unknown Title',
            duration: item.duration || 0,
            channel: item.uploader || item.channel || 'Unknown Artist',
            url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
            streamUrl: null
          });
        } catch {
          // ignore corrupted lines
        }
      }

      return results;
    } catch (err) {
      throw new Error(`YouTube search failed: ${err.message}`);
    }
  }

  /**
   * Get metadata and stream URL for a specific video ID or URL in a single call
   * @param {string} urlOrId
   */
  async getVideoInfo(urlOrId) {
    const url = this.toWatchUrl(urlOrId);
    const args = [
      url,
      '--dump-json',
      '-f', 'ba/b',
      '--no-playlist',
      '--no-warnings'
    ];

    try {
      const { stdout } = await execFileAsync(this.ytdlpBinary, args, {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      });

      const data = JSON.parse(stdout);
      return {
        id: data.id,
        title: data.title || 'Unknown Title',
        duration: data.duration || 0,
        channel: data.uploader || data.channel || 'Unknown Artist',
        url: `https://www.youtube.com/watch?v=${data.id}`,
        streamUrl: data.url || `https://www.youtube.com/watch?v=${data.id}`
      };
    } catch (err) {
      throw new Error(`Failed to fetch video info: ${err.message}`);
    }
  }

  /**
   * Resolve direct audio stream URL if not already present
   * @param {string} urlOrId
   */
  async getAudioStreamUrl(urlOrId) {
    const url = this.toWatchUrl(urlOrId);
    const args = [
      url,
      '-g',
      '-f', 'ba/b',
      '--no-playlist',
      '--no-warnings'
    ];

    try {
      const { stdout } = await execFileAsync(this.ytdlpBinary, args, {
        windowsHide: true
      });
      return stdout.trim().split('\n')[0];
    } catch {
      return url;
    }
  }

  /**
   * Formats a raw ID or URL into a standard youtube watch URL
   */
  toWatchUrl(input) {
    const trimmed = input.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (trimmed.startsWith('youtu.be/')) {
      return `https://${trimmed}`;
    }
    if (trimmed.startsWith('www.youtube.com/')) {
      return `https://${trimmed}`;
    }
    return `https://www.youtube.com/watch?v=${trimmed}`;
  }

  /**
   * Extracts video ID if possible
   */
  extractVideoId(input) {
    const match = input.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([\w-]{11})/);
    if (match) return match[1];
    if (/^[\w-]{11}$/.test(input.trim())) return input.trim();
    return null;
  }
}
