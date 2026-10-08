# scripts/setup.ps1 - Automated portable binary downloader for YTSync
[CmdletBinding()]
param (
    [switch]$Prompt = $false,
    [string]$BinDir = "$PSScriptRoot\..\bin"
)

$ErrorActionPreference = 'Stop'

# Ensure destination directory exists
if (-not (Test-Path -Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$BinDir = (Resolve-Path -Path $BinDir).Path

$nodePath = Join-Path $BinDir "node.exe"
$ytdlpPath = Join-Path $BinDir "yt-dlp.exe"
$mpvPath = Join-Path $BinDir "mpv.exe"

$missing = @()
if (-not (Test-Path $nodePath)) { $missing += "Node.js (portable)" }
if (-not (Test-Path $ytdlpPath)) { $missing += "yt-dlp (YouTube engine)" }
if (-not (Test-Path $mpvPath)) { $missing += "MPV (audio player)" }

if ($missing.Count -eq 0) {
    Write-Host ""
    Write-Host " [OK] All required portable binaries are already present in bin/" -ForegroundColor Green
    Write-Host ""
    exit 0
}

Write-Host "`n ======================================================================" -ForegroundColor Cyan
Write-Host "                    YTSync - Portable Binary Setup                      " -ForegroundColor Cyan
Write-Host " ======================================================================`n" -ForegroundColor Cyan

Write-Host " The following portable dependencies need to be configured:" -ForegroundColor Yellow
foreach ($item in $missing) {
    Write-Host "   - $item" -ForegroundColor Gray
}
Write-Host ""

if ($Prompt) {
    $choice = Read-Host " Would you like to automatically download them now? (Y/N)"
    if ($choice -notmatch '^(y|yes)$') {
        Write-Host " Setup cancelled. Existing system tools will be used if available.`n" -ForegroundColor Yellow
        exit 0
    }
}

# 1. Download Node.js portable
if (-not (Test-Path $nodePath)) {
    Write-Host " [1/3] Downloading portable Node.js v22..." -ForegroundColor Cyan
    $nodeUrl = "https://nodejs.org/dist/v22.12.0/win-x64/node.exe"
    curl.exe -fLo "$nodePath" --progress-bar "$nodeUrl"
    if (-not (Test-Path $nodePath)) {
        Write-Host " [!] Failed to download Node.js" -ForegroundColor Red
        exit 1
    }
    Write-Host " [OK] Node.js installed to bin\node.exe" -ForegroundColor Green
} else {
    Write-Host " [OK] Node.js is already installed" -ForegroundColor Green
}

# 2. Download yt-dlp
if (-not (Test-Path $ytdlpPath)) {
    Write-Host "`n [2/3] Downloading yt-dlp..." -ForegroundColor Cyan
    $ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    curl.exe -fLo "$ytdlpPath" -L --progress-bar "$ytdlpUrl"
    if (-not (Test-Path $ytdlpPath)) {
        Write-Host " [!] Failed to download yt-dlp" -ForegroundColor Red
        exit 1
    }
    Write-Host " [OK] yt-dlp installed to bin\yt-dlp.exe" -ForegroundColor Green
} else {
    Write-Host " [OK] yt-dlp is already installed" -ForegroundColor Green
}

# 3. Download MPV
if (-not (Test-Path $mpvPath)) {
    Write-Host "`n [3/3] Downloading & extracting MPV..." -ForegroundColor Cyan
    $tempArchive = Join-Path $env:TEMP "mpv_ytsync_setup.7z"
    
    $mpvUrl = try {
        $headers = @{ "User-Agent" = "YTSync-Setup" }
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest" -Headers $headers -TimeoutSec 6
        ($rel.assets | Where-Object { $_.name -match '^mpv-x86_64-.*\.7z$' -and $_.name -notmatch 'v3' } | Select-Object -First 1).browser_download_url
    } catch {
        "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261008/mpv-x86_64-20261008-git-36bf3d5290.7z"
    }

    if (-not $mpvUrl) {
        $mpvUrl = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261008/mpv-x86_64-20261008-git-36bf3d5290.7z"
    }

    curl.exe -fLo "$tempArchive" -L --progress-bar "$mpvUrl"
    
    if (-not (Test-Path $tempArchive)) {
        Write-Host " [!] Failed to download MPV archive" -ForegroundColor Red
        exit 1
    }

    Write-Host "       Extracting mpv.exe into bin\..." -ForegroundColor Gray
    tar.exe -xf "$tempArchive" -C "$BinDir" mpv.exe
    Remove-Item -Force "$tempArchive" -ErrorAction SilentlyContinue

    if (-not (Test-Path $mpvPath)) {
        Write-Host " [!] Failed to extract mpv.exe" -ForegroundColor Red
        exit 1
    }
    Write-Host " [OK] MPV installed to bin\mpv.exe" -ForegroundColor Green
} else {
    Write-Host " [OK] MPV is already installed" -ForegroundColor Green
}

Write-Host ""
Write-Host " ======================================================================" -ForegroundColor Green
Write-Host "   [OK] Portable setup completed! All tools ready in bin/" -ForegroundColor Green
Write-Host " ======================================================================" -ForegroundColor Green
Write-Host ""
exit 0
