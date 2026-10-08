# 🎵 YTSync

<p align="center">
  <b>Ultra-lightweight terminal YouTube music player with real-time peer sync over LAN & Radmin VPN.</b><br>
  <i>Zero external npm dependencies · Portable zero-setup mode · Headless in-memory audio streaming</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Engine-MPV%20%2B%20yt--dlp-purple" alt="MPV" />
  <img src="https://img.shields.io/badge/Dependencies-Zero%20npm-brightgreen" alt="Dependencies" />
  <img src="https://img.shields.io/badge/Network-Radmin%20VPN%20%7C%20LAN-orange" alt="Network" />
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="License" />
</p>

---

## ⚡ Highlights

* **Automatic Room Discovery**: No need to manually copy-paste IP addresses! The interactive launcher broadcasts UDP beacons across Radmin VPN (`26.x.x.x`) and home Wi-Fi/Ethernet subnets so friends can join with **1 click**.
* **Zero-Setup Portable Mode**: Don't have Node.js, MPV, or yt-dlp installed? Just double-click `start.bat`. It will prompt to automatically download lightweight portable binaries directly into `bin/` in seconds.
* **Instant In-Memory Streaming**: Uses MPV's native 60-second in-memory lookahead buffer (`--demuxer-readahead-secs=60`). No video files are downloaded to disk, keeping disk clutter at zero.
* **Sub-Second Precision Sync**: Host and guests share synchronized playback state for **Play**, **Pause**, **Seek**, and **Queue** over a low-latency TCP socket.
* **Smart Local Resolving (No 403 Forbidden)**: YouTube stream URLs are signed to each client's IP. The host broadcasts track IDs, and each peer resolves audio streams locally via MPV and yt-dlp so music never fails or buffers indefinitely.
* **Zero External npm Dependencies**: Built purely with Node.js built-in standard libraries (`node:net`, `node:dgram`, `node:child_process`, `node:readline`). Extremely lightweight (~15MB RAM, <1% CPU).

---

## 🚀 Quick Start

### 1. Clone or Download
```powershell
git clone https://github.com/GGTaha/ytsync.git
cd ytsync
```

### 2. Launch
Double-click **`start.bat`** (or run `.\start.bat` in PowerShell / CMD).

```text
╔══════════════════════════════════════════════════════════════════════╗
║                    🎵 YTSYNC TERMINAL MUSIC PLAYER                   ║
╚══════════════════════════════════════════════════════════════════════╝

 Your Network Information:
   ● Radmin VPN IP:  26.1.68.220
   ● Local LAN IP:   192.168.1.5
────────────────────────────────────────────────────────────────────────

 Select an option:

   [1] 🏠 Host a Session          (Start your room & allow peers to join)
   [2] 🔍 Join a Session          (Auto-scan for available rooms)
   [3] ⌨️  Join by IP Manually     (Enter friend's Radmin IP directly)
   [q] ❌ Exit

 Press 1, 2, 3, or q:
```

> **First Run**: If portable tools are not yet downloaded in `bin/`, `start.bat` will ask if you want to automatically download them. Type `Y` and it will configure everything automatically!

---

## 👥 How to Play Together

### Option A: Over Radmin VPN (Play with Friends Anywhere)
1. Both you and your friend open **Radmin VPN** and join the same virtual network room.
2. **Host**: Double-click `start.bat` and press **`[1]`** to Host.
3. **Guest (Friend)**: Double-click `start.bat` and press **`[2]`** to Join.
   * YTSync scans the network and shows your room:
     ```text
      Found 1 active room(s):
        [1] YOUR-PC (26.1.68.220:4455) [Radmin VPN]
     ```
   * Your friend presses **`[1]`** to connect instantly!
4. Anyone can search for songs, queue tracks, pause, or seek—playback syncs across both computers in real time.

### Option B: Over Local Wi-Fi / LAN (Same House or Office)
* No VPN needed! Follow the same steps above—the UDP discovery scanner automatically finds hosts on your home Wi-Fi or Ethernet router (`192.168.x.x`).

---

## ⌨️ Keyboard Controls

| Key | Action | Scope |
| :---: | :--- | :---: |
| **`Space`** | Toggle Play / Pause | **Synced** (All peers) |
| **`←` / `→`** | Seek $\pm 5$ seconds | **Synced** (All peers) |
| **`s`** | Search YouTube & pick from top 5 results | **Synced** (Plays/Queues) |
| **`a`** | Add YouTube URL or Video ID directly | **Synced** (Plays/Queues) |
| **`n`** | Skip to next track in queue | **Synced** (All peers) |
| **`+` / `-`** | Increase / Decrease volume | **Local** (Per machine) |
| **`m`** | Toggle Mute | **Local** (Per machine) |
| **`q`** | Quit player & close background engine | **Local** |

---

## 🛠️ CLI Mode (Advanced)

If you prefer launching directly via terminal commands or automated scripts without the interactive menu:

```powershell
# Start as Host on default port 4455
node src/index.js --host --port 4455

# Join a friend directly by IP
node src/index.js --join 26.1.68.220:4455

# Specify custom binary paths if desired
node src/index.js --mpv "C:\custom\mpv.exe" --ytdlp "C:\custom\yt-dlp.exe"

# Display CLI help
node src/index.js --help
```

---

## 🌐 Network & Architecture

```text
               ┌────────────────────────────────────────────────────────┐
               │                      HOST SESSION                      │
               │  • MPV Headless Audio Engine (Windows Named Pipe IPC)  │
               │  • TCP Sync Server (Port 4455)                         │
               │  • UDP Discovery Beacon Responder (Port 4456)          │
               └───────────────▲────────────────────────▲───────────────┘
                               │                        │
                    UDP Auto-Discovery            TCP Room Sync
                    (Port 4456 Broadcast)         (Heartbeats & Actions)
                               │                        │
               ┌───────────────┴────────────────────────┴───────────────┐
               │                     GUEST SESSION                      │
               │  • Discovers host on Radmin VPN / LAN                  │
               │  • MPV Headless Audio Engine                           │
               │  • Resolves local signed audio streams                 │
               │  • Auto-aligns drift and pause states                  │
               └────────────────────────────────────────────────────────┘
```

* **TCP Port `4455`**: Primary peer synchronization channel. Broadcasts queue events, play/pause commands, seek timestamps, and 1-second drift heartbeats.
* **UDP Port `4456`**: Network discovery beacons. Used by `src/discovery.js` to announce and detect active rooms across network adapters.

---

## ❓ Troubleshooting

* **Firewall Prompt**: Windows Defender Firewall may ask for permission on first run. Click **Allow** on Private networks (and Public if using Radmin VPN) to allow TCP/UDP sync.
* **Host Not Showing Up in Scan**:
  - Make sure both machines have Radmin VPN connected and showing a green light.
  - If broadcast packets are blocked by a strict firewall, use option **`[3] Join by IP Manually`** and type the Host's Radmin IP directly (e.g. `26.1.68.220`).
* **Audio Stuttering**: Ensure your internet connection has enough bandwidth for YouTube audio streams (~128-160 kbps). YTSync automatically buffers up to 60 seconds ahead into RAM to avoid stutter.

---

## 📜 License

MIT License. Free to use, modify, and distribute.
