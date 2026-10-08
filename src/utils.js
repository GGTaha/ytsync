import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

/**
 * Reads text from Windows system clipboard
 */
export function getClipboard() {
  if (process.platform === 'win32') {
    try {
      const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2000
      });
      return text.trim();
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Ensures Windows PATH contains WinGet package locations and refreshed registry PATH
 */
export function ensureEnvironmentPath() {
  if (process.platform !== 'win32') return;

  const currentPath = process.env.PATH || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const potentialDirs = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts'),
    path.join(userProfile, 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
  ];

  // Also check WinGet package directories directly
  const wingetPackagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetPackagesDir)) {
    try {
      const subdirs = fs.readdirSync(wingetPackagesDir);
      for (const dir of subdirs) {
        potentialDirs.push(path.join(wingetPackagesDir, dir));
      }
    } catch {}
  }

  const pathParts = currentPath.split(';');
  for (const dir of potentialDirs) {
    if (fs.existsSync(dir) && !pathParts.includes(dir)) {
      pathParts.unshift(dir);
    }
  }

  process.env.PATH = pathParts.join(';');
}

/**
 * Resolves an executable binary name by checking PATH and common fallback locations
 */
export function resolveBinary(name) {
  // First check local project ./bin folder or cwd (for portable setups)
  const localBinDirs = [
    path.join(process.cwd(), 'bin'),
    process.cwd()
  ];
  for (const dir of localBinDirs) {
    const target = path.join(dir, `${name}.exe`);
    if (fs.existsSync(target)) return target;
  }

  ensureEnvironmentPath();

  try {
    const cmd = process.platform === 'win32' ? `where.exe ${name}` : `which ${name}`;
    const result = execSync(cmd, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const matches = result.trim().split('\n').map(s => s.trim()).filter(Boolean);
    // On Windows, prioritize .exe over .com to avoid console wrapper processes
    const exeMatch = matches.find(m => m.toLowerCase().endsWith('.exe'));
    if (exeMatch) return exeMatch;
    if (matches[0]) return matches[0];
  } catch {}

  // Fallback to searching known WinGet locations on Windows
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const wingetPackagesDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetPackagesDir)) {
      try {
        const subdirs = fs.readdirSync(wingetPackagesDir);
        for (const dir of subdirs) {
          const target = path.join(wingetPackagesDir, dir, `${name}.exe`);
          if (fs.existsSync(target)) return target;
          const targetCom = path.join(wingetPackagesDir, dir, `${name}.com`);
          if (fs.existsSync(targetCom)) return targetCom;
        }
      } catch {}
    }
  }

  return name; // fallback to plain name
}
