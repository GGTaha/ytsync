# 📖 Codebase Architecture & Function Reference

This document provides a comprehensive technical overview of all files, classes, methods, protocols, and data flows within the **YTSync** codebase.

---

## 🗂️ Directory Structure

```
ytsync/
├── bin/                       # Portable binaries (node.exe, mpv.exe, yt-dlp.exe)
├── scripts/
│   └── setup.ps1              # Automated portable binary downloader & extractor
├── src/
│   ├── index.js               # CLI entry point & interactive launcher routing
│   ├── launcher.js            # Interactive startup TUI menu & auto-discovery UI
│   ├── discovery.js           # UDP network adapter inspection & beacon scanner
│   ├── app.js                 # Central state machine & sync orchestrator
│   ├── sync.js                # TCP networking protocol (HostSync & ClientSync)
│   ├── mpv.js                 # Headless MPV controller via Windows Named Pipes
│   ├── youtube.js             # YouTube metadata & audio resolver (yt-dlp)
│   ├── ui.js                  # ANSI Terminal UI, views, and keyboard router
│   └── utils.js               # Windows clipboard reader & binary path resolver
├── .gitignore                 # Excludes bin/, data/, temporary artifacts
├── package.json               # Node.js ESM package configuration (zero npm deps)
├── README.md                  # Main project guide & quick start documentation
└── start.bat                  # One-click Windows runner & portable binary setup
```

---

## 1. `src/index.js` (Application Entry Point)

The primary entry point executed when starting YTSync.

### Functions & Responsibilities:
* `parseArgs()`:
  - Parses command-line arguments (`process.argv.slice(2)`).
  - Flags handled:
    - `--host`: Runs as host.
    - `--join <ip:port>`: Runs as guest connected to remote host.
    - `--port <number>`: Custom TCP port (defaults to 4455).
    - `--mpv <path>`: Custom MPV binary path.
    - `--ytdlp <path>`: Custom yt-dlp binary path.
    - `-h, --help`: Displays CLI usage.
  - Sets `options.modeSpecified = true` if `--host` or `--join` were explicitly provided.
* `main()`:
  - If no CLI mode was specified, calls `await runInteractiveLauncher()` to present the user with the startup TUI menu.
  - Instantiates `App` and `TerminalUI`.
  - Binds status updates: `app.onStatusChange = (msg) => ui.setStatus(msg)`.
  - Initializes the engine: `await app.init()`.
  - Starts terminal loop: `ui.start()`.

---

## 2. `src/launcher.js` (Interactive Startup Menu)

Provides the interactive ANSI startup screen when the user double-clicks `start.bat` without CLI arguments.

### Functions & Responsibilities:
* `promptLine(promptText)`:
  - Reads a full string of user input asynchronously in raw mode with character echo, backspace handling, and Ctrl+C interrupt support.
* `promptSingleKey()`:
  - Waits for a single keypress in raw mode and resolves immediately with `{ str, key }`.
* `runInteractiveLauncher()`:
  - Clears screen and renders ASCII header banner.
  - Displays detected local network information (Radmin VPN IP, Local LAN IP).
  - Displays menu options:
    - `[1] Host a Session`
    - `[2] Join a Session` (triggers auto-scan)
    - `[3] Join by IP Manually`
    - `[q] Exit`
  - Returns `{ isHost: boolean, port: number, join: string|null }`.
* `runScanSubmenu()`:
  - Calls `scanForHosts(1600)` to discover active UDP beacons across subnets.
  - Displays discovered rooms with their network badge (`[Radmin VPN]` or `[Local LAN]`).
  - Supports 1-click room selection (`[1]`, `[2]`), rescan (`[r]`), manual IP fallback (`[m]`), or back (`[b]`).
* `runManualIpPrompt()`:
  - Prompts for a manual host IP and automatically appends `:4455` if port was omitted.

---

## 3. `src/discovery.js` (UDP Network Auto-Discovery)

Implements peer auto-discovery across Radmin VPN and LAN network interfaces using UDP port 4456.

### Functions & Responsibilities:
* `getNetworkDetails()`:
  - Uses `os.networkInterfaces()` to find all active non-internal IPv4 adapters.
  - Classifies adapter types (`Radmin VPN`, `Local LAN`, `Tailscale`, `Wi-Fi`, `Ethernet`).
  - Returns `Array<{ name, address, netmask, type }>`.
* `getBroadcastAddresses()`:
  - Computes the correct subnet broadcast address for each network interface using bitwise math: `ipParts | (~maskParts & 255)`.
  - Examples: `26.255.255.255` (Radmin VPN), `192.168.1.255` (home LAN), `255.255.255.255` (global broadcast).
* `startHostDiscovery(port = 4455, udpPort = 4456)`:
  - Binds a UDP socket on port 4456 with `reuseAddr: true`.
  - Listens for incoming `{"type": "DISCOVER"}` packets and replies directly with `HOST_ANNOUNCE`.
  - Also sends periodic background `HOST_ANNOUNCE` beacons every 2.5 seconds to all broadcast addresses.
  - Returns `{ close() }` to gracefully clean up timers and sockets on shutdown.
* `scanForHosts(timeoutMs = 1500, udpPort = 4456)`:
  - Creates a client UDP socket with broadcast enabled.
  - Broadcasts `{"type": "DISCOVER"}` to all detected network subnet broadcasts.
  - Listens for responses and deduplicates hosts by `hostname:port`, prioritizing Radmin VPN addresses.
  - Resolves `Array<{ name, ip, port, type }>`.

---

## 4. `src/app.js` (Central Application Orchestrator)

The core coordinator that connects MPV playback, YouTube audio extraction, TCP synchronization, and user actions.

### Key Class: `App`

#### Constructor & Lifecycle:
* `constructor(options)`: Initializes sub-controllers, track queue, peer counts, and detects best local IP for display.
* `init()`:
  - Starts the MPV process (`await mpv.start()`).
  - Registers MPV event observers (`end-file`, `time-pos`, `pause`).
  - If **Host**: Starts UDP discovery beacon (`startHostDiscovery`) and TCP server (`HostSync.start()`).
  - If **Guest**: Instantiates `ClientSync` and registers room state synchronization listeners (`room-state`, `load-track`, `play`, `pause`, `seek`, `heartbeat`).
* `destroy()`:
  - Cleanly shuts down discovery UDP sockets, TCP sync sockets, and terminates headless MPV child processes via Windows Named Pipes and `taskkill`.

#### Playback & Queue Methods:
* `play()`: Unpauses MPV playback. If Host, broadcasts `PLAY` action to peers. If Guest, sends `ACTION_PLAY` request to Host.
* `pause()`: Pauses MPV playback. Broadcasts or requests pause sync.
* `seek(seconds)`: Seeks MPV by relative offset (`+5` or `-5`). Broadcasts or requests seek sync.
* `playTrack(track)`:
  - Strips local `streamUrl` before updating sync state so peers resolve their own signed audio streams.
  - Sets track as `currentTrack`, loads into local MPV player, and broadcasts `LOAD_TRACK` event.
* `queueTrack(track)`: Appends track to `queue`. If nothing is currently playing, plays it immediately; otherwise broadcasts `QUEUE_UPDATE`.
* `nextTrack()`: Pops next track from `queue` and plays it, or stops playback if queue is empty.
* `setVolume(volume)`: Adjusts local MPV playback volume ($0$ to $100\%$).
* `search(query)`: Queries YouTube for search results via `YouTubeService`.
* `resolveVideo(urlOrId)`: Fetches track metadata for direct YouTube URLs.
* `getState()`: Returns comprehensive snapshot for `TerminalUI` (track metadata, duration, playback time, volume, pause state, peer count, ping).

#### Drift Correction & Buffering Guard:
* `_loadTrackLocally(track, startPos, paused)`:
  - Prevents 403 Forbidden errors by fetching a fresh direct audio URL using local yt-dlp.
  - Loads stream into MPV with a 60-second read-ahead buffer.
* `heartbeat listener`:
  - Enforces a **6-second initial buffering grace period** (`lastTrackLoadTime`) so MPV can populate its memory cache without mid-buffer seek interruptions.
  - Enforces a **5-second seek cooldown** (`lastAutoSeekTime`) to prevent ping-pong seeking loops.
  - Resynchronizes only if drift exceeds 2.5 seconds during active rolling playback.

---

## 5. `src/sync.js` (TCP Peer Synchronization Engine)

Implements the lightweight JSON-over-TCP protocol with newline framing (`\n`).

### Key Classes:

#### 1. `HostSync extends EventEmitter`
* Listens on TCP port `4455`.
* Manages connected sockets (`Set<net.Socket>`).
* Sends full room state (`ROOM_STATE`) when a new guest connects.
* Sends periodic heartbeats (`HEARTBEAT`) every 1000ms containing current `timePos` and `paused` status.
* Receives guest actions (`ACTION_PLAY`, `ACTION_PAUSE`, `ACTION_SEEK`, `ACTION_QUEUE`) and emits them to `App` for room-wide broadcast.
* Broadcasts events: `broadcast(type, payload)`.

#### 2. `ClientSync extends EventEmitter`
* Connects to Host at `<host>:<port>`.
* Implements automatic reconnection with exponential backoff if disconnected.
* Computes latency/ping via periodic `PING`/`PONG` roundtrip packets.
* Emits room events to `App`: `room-state`, `load-track`, `play`, `pause`, `seek`, `queue-update`, `heartbeat`.

---

## 6. `src/mpv.js` (Headless MPV IPC Controller)

Controls a headless, zero-window MPV process using native Windows Named Pipes (`\\.\pipe\ytsync_mpv_<timestamp>`).

### Key Class: `MpvController extends EventEmitter`
* `start()`:
  - Spawns `mpv.exe` (specifically avoiding `mpv.com` to prevent orphaned background processes).
  - Flags configured:
    - `--idle=yes`: Keeps MPV alive when no tracks are loaded.
    - `--no-video`: Zero GPU/video rendering overhead.
    - `--demuxer-readahead-secs=60`: 60-second in-memory audio lookahead.
    - `--cache=yes`: RAM caching enabled.
    - `--ytdl-format=bestaudio/best`: High quality audio selection.
    - `--input-ipc-server=\\.\pipe\...`: Named pipe endpoint.
  - Polls pipe connection until ready and initializes property observers.
* `_sendCommand(command, args)`:
  - Writes JSON-RPC requests to the Named Pipe: `{"command": [command, ...args], "request_id": id}\n`.
* `_observeProperties()`:
  - Subscribes to MPV events: `time-pos`, `pause`, `duration`, `volume`, `idle-active`, and `eof-reached`.
* `loadStream(url, startPos, paused)`:
  - Sends `loadfile` command with `start=<startPos>` and `pause=<yes|no>`.
* `play()`, `pause()`, `seek(pos)`, `seekRelative(seconds)`, `setVolume(vol)`:
  - Standard JSON-RPC wrapper commands.
* `destroy()`:
  - Sends `quit` over IPC, destroys socket, kills process tree via `taskkill /F /T /PID <pid>`, and unlinks named pipe.

---

## 7. `src/youtube.js` (YouTube Metadata Service)

Wrapper around `yt-dlp` for video metadata extraction and audio stream resolution.

### Key Class: `YouTubeService`
* `search(query, limit = 5)`:
  - Runs `yt-dlp --dump-json "ytsearch<limit>:<query>"`.
  - Parses JSON output into clean track objects: `{ id, title, channel, duration, url }`.
* `getVideoInfo(urlOrId)`:
  - Extracts metadata for a specific YouTube URL or 11-character video ID.
* `getDirectStreamUrl(urlOrId)`:
  - Executes `yt-dlp -g -f bestaudio/best <url>` to extract the direct HTTPS audio stream link.

---

## 8. `src/ui.js` (Terminal User Interface)

Lightweight ANSI terminal UI operating in raw keyboard mode with zero external npm UI dependencies.

### Key Class: `TerminalUI`
* `start()`:
  - Hides terminal cursor (`\x1B[?25l`), enables raw mode (`process.stdin.setRawMode(true)`), and starts a 150ms render loop.
  - Registers cleanup hooks on `SIGINT`, `SIGTERM`, `SIGHUP`, and process `exit`.
* `render()`:
  - Clears top-to-bottom and draws styled Unicode box headers.
  - Displays Host/Guest role, Radmin IP, connected peer count, and ping latency.
  - Renders **Now Playing** info with status badge (`▶ PLAYING`, `⏸ PAUSED`, `⏳ BUFFERING`).
  - Draws dynamic progress bar: `[████████████░░░░░░░░░░░░] 01:23 / 03:45`.
  - Renders volume bar and queue list.
  - Conditionally renders sub-views:
    - **Normal View**: Displays upcoming queue and playback controls.
    - **Input View (`[s]` / `[a]`)**: Inline search or URL input buffer with backspace and Ctrl+V clipboard support.
    - **Results View**: Top 5 search results selectable via keys `[1-5]`.
* `_handleKeypress(str, key)`:
  - Dispatches keys based on current active view:
    - Navigation: Space (pause/play), Left/Right (seek), `n` (skip), `+`/`-` (volume), `m` (mute), `q` (quit).
    - Input: typing, Enter (submit), Esc (cancel), Backspace (delete).

---

## 9. `src/utils.js` (System & Formatting Utilities)

Helper functions used across the application.

* `resolveBinary(binaryName)`:
  - Checks if `bin\<binaryName>.exe` exists in the local portable folder.
  - If not found, falls back to searching system `PATH`.
* `getClipboard()`:
  - Reads text from Windows clipboard via PowerShell `Get-Clipboard`.
* `formatDuration(seconds)`: Formats numeric seconds into `MM:SS`.
* `isYouTubeUrl(str)`: Regex validator checking for `youtube.com` or `youtu.be` links.

---

## 10. `start.bat` & `scripts/setup.ps1` (Portable Launcher & Setup)

* **`start.bat`**:
  - Adds `bin\` to session `PATH`.
  - Inspects whether `bin\node.exe`, `bin\mpv.exe`, and `bin\yt-dlp.exe` are present.
  - If any are missing, prompts user to automatically download them via `setup.ps1`.
  - Launches application using `bin\node.exe src\index.js %*`.
* **`scripts/setup.ps1`**:
  - Downloads portable standalone Node.js (`nodejs.org/dist/v22.12.0/win-x64/node.exe`).
  - Downloads `yt-dlp.exe` from official GitHub release.
  - Downloads portable MPV 7z archive from `shinchiro/mpv-winbuild-cmake` and extracts `mpv.exe` directly via Windows built-in `tar.exe`.
  - Cleans up temporary download files.
