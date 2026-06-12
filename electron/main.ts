import { app, BrowserWindow, ipcMain, Tray, nativeImage, Menu, screen, dialog, Notification } from 'electron';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { scrapeClaudeUsage, openLoginWindow, openPlatformLoginWindow, isAuthenticated } from './scraper';
import { getUsageReport, getCostReport, getCreditBalance, ApiData } from './adminApi';

// Disable default error dialogs in production
if (app.isPackaged) {
  dialog.showErrorBox = () => {};
}

// Handle uncaught exceptions to prevent crashes from EPIPE errors
process.on('uncaughtException', (error) => {
  // Ignore EPIPE errors which occur when writing to closed pipes
  if (error.message?.includes('EPIPE')) {
    return;
  }
  // In dev mode, log to console; in prod, silently ignore non-critical errors
  if (!app.isPackaged) {
    console.error('Uncaught exception:', error);
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message?.includes('EPIPE')) {
    return;
  }
  if (!app.isPackaged) {
    console.error('Unhandled rejection:', reason);
  }
});

// Load environment variables - try multiple paths
const envPaths = [
  path.join(__dirname, '..', '.env.local'),
  path.join(app.getAppPath(), '.env.local'),
  path.join(process.cwd(), '.env.local'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    console.log('Loading .env.local from:', envPath);
    dotenv.config({ path: envPath });
    break;
  }
}

console.log('Admin key configured:', !!process.env.ANTHROPIC_ADMIN_KEY);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let refreshInterval: NodeJS.Timeout | null = null;

const isDev = !app.isPackaged;

// Track notified thresholds to avoid duplicate notifications
const notifiedThresholds: Record<string, number> = {};
const NOTIFICATION_THRESHOLDS = [80, 90];

// Track previous percentages for Telegram notifications
const previousPercentages: Record<string, number> = {};

async function sendTelegramMessage(message: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) return;

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      console.error('Telegram API error:', response.status, await response.text());
    }
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
  }
}

function checkAndNotify(bars: Array<{ percentage: number; label?: string; context?: string }>) {
  // Telegram: only track "Current session" / "현재 세션"
  const sessionBar = bars.find(b =>
    b.label?.toLowerCase().includes('current session') ||
    b.label?.includes('현재 세션')
  );
  if (sessionBar) {
    const label = sessionBar.label || 'Current session';
    const resetTime = formatResetTime(sessionBar.context);
    const resetSuffix = resetTime ? `\n⏳ 남은 시간: ${resetTime}` : '';
    const prevPct = previousPercentages[label];
    if (prevPct === undefined) {
      sendTelegramMessage(
        `📊 <b>Claude Usage</b>\n${label}: ${sessionBar.percentage}%${resetSuffix}`
      );
      addLog(`Telegram: ${label} initial ${sessionBar.percentage}%`);
    } else {
      const prevBucket = Math.floor(prevPct / 10);
      const currBucket = Math.floor(sessionBar.percentage / 10);
      if (currBucket > prevBucket) {
        sendTelegramMessage(
          `⚠️ <b>Claude Usage Alert</b>\n${label}: ${prevPct}% → ${sessionBar.percentage}%${resetSuffix}`
        );
        addLog(`Telegram: ${label} ${prevPct}% → ${sessionBar.percentage}%`);
      }
    }
    previousPercentages[label] = sessionBar.percentage;
  }

  for (const bar of bars) {
    const label = bar.label || 'Usage';

    // macOS native notifications at thresholds
    for (const threshold of NOTIFICATION_THRESHOLDS) {
      const key = `${label}-${threshold}`;
      if (bar.percentage >= threshold && !notifiedThresholds[key]) {
        notifiedThresholds[key] = Date.now();
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: 'Claude Usage Alert',
            body: `${label}: ${bar.percentage}% used (${threshold}% threshold reached)`,
            silent: false,
          });
          notification.show();
        }
      }
    }
    // Reset notifications when usage drops below threshold
    for (const threshold of NOTIFICATION_THRESHOLDS) {
      const key = `${label}-${threshold}`;
      if (bar.percentage < threshold && notifiedThresholds[key]) {
        delete notifiedThresholds[key];
      }
    }
  }
}

// Activity log system - keep last 20 entries
interface LogEntry {
  timestamp: string;
  message: string;
}
const activityLogs: LogEntry[] = [];
const MAX_LOGS = 20;

function addLog(message: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    message
  };
  activityLogs.push(entry);
  if (activityLogs.length > MAX_LOGS) {
    activityLogs.shift();
  }
  console.log(`[${entry.timestamp}] ${message}`);
}

function getRecentLogs(count: number = 6): LogEntry[] {
  return activityLogs.slice(-count);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 340,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, __dirname is inside app.asar/dist-electron
    // So we need to go up one level to get to dist/index.html
    const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
    console.log('Loading HTML from:', htmlPath);
    mainWindow.loadFile(htmlPath);
  }

  mainWindow.on('blur', () => {
    mainWindow?.hide();
  });

  // Auto-resize window to fit content
  ipcMain.on('app:resize', (_event, height: number) => {
    if (!mainWindow) return;
    const clampedHeight = Math.min(Math.max(height + 2, 100), 700);
    const [width] = mainWindow.getSize();
    mainWindow.setSize(width, clampedHeight);
  });
}

function createTray() {
  // Create a simple icon - in production, use a proper icon file
  const iconPath = path.join(__dirname, '..', 'assets', 'trayIconTemplate.png');
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // Fallback: create a simple 16x16 icon
      icon = nativeImage.createEmpty();
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  // If icon is empty, create a basic one programmatically
  if (icon.isEmpty()) {
    // Create a 16x16 basic icon
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      canvas[i * 4] = 100;     // R
      canvas[i * 4 + 1] = 100; // G
      canvas[i * 4 + 2] = 100; // B
      canvas[i * 4 + 3] = 255; // A
    }
    icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  tray = new Tray(icon);
  tray.setToolTip('Claude Usage Tool');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Refresh', click: () => refreshAllData() },
    { label: 'Login to Claude', click: () => openLoginWindow() },
    { type: 'separator' },
    {
      label: 'About',
      click: () => {
        const aboutWindow = new BrowserWindow({
          width: 300,
          height: 200,
          resizable: false,
          minimizable: false,
          maximizable: false,
          title: 'About Claude Usage Tool',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
        const iconBase64 = fs.existsSync(iconPath)
          ? 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64')
          : '';

        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
                background: #1a1a1a;
                color: #fff;
                text-align: center;
                -webkit-user-select: none;
              }
              img { width: 64px; height: 64px; margin-bottom: 12px; }
              h1 { font-size: 16px; margin: 0 0 4px 0; font-weight: 600; }
              .version { font-size: 12px; color: #888; margin-bottom: 8px; }
              .author { font-size: 12px; color: #aaa; }
              a { color: #d97706; text-decoration: none; }
              a:hover { text-decoration: underline; }
            </style>
          </head>
          <body>
            <img src="${iconBase64}" alt="icon" />
            <h1>Claude Usage Tool</h1>
            <div class="version">ver 0.10</div>
            <div class="author">by <a href="mailto:kingi@kingigilbert.com">Kingi Gilbert</a></div>
          </body>
          </html>
        `;

        aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        aboutWindow.setMenu(null);
      }
    },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });

  tray.on('right-click', () => {
    tray?.popUpContextMenu(contextMenu);
  });
}

function showWindow() {
  if (!mainWindow || !tray) {
    console.log('showWindow: mainWindow or tray is null');
    return;
  }

  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });

  console.log('Tray bounds:', trayBounds);
  console.log('Window bounds:', windowBounds);
  console.log('Display bounds:', display.bounds);

  // Position window below tray icon (macOS style)
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  // Ensure window is within display bounds
  if (x + windowBounds.width > display.bounds.x + display.bounds.width) {
    x = display.bounds.x + display.bounds.width - windowBounds.width;
  }
  if (x < display.bounds.x) {
    x = display.bounds.x;
  }

  mainWindow.setPosition(x, y, false);
  mainWindow.show();
  mainWindow.focus();
}

function formatResetTime(context?: string): string {
  if (!context) return '';
  // Extract time portion from strings like "Resets in 3 hr 20 min" or "3시간 20분 후 초기화"
  const enMatch = context.match(/(\d+)\s*hr?\s*(\d+)?\s*min?/i);
  if (enMatch) {
    const hours = enMatch[1];
    const minutes = enMatch[2];
    return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  const krMatch = context.match(/(\d+)\s*시간\s*(\d+)?\s*분?/);
  if (krMatch) {
    const hours = krMatch[1];
    const minutes = krMatch[2];
    return minutes ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  const minOnly = context.match(/(\d+)\s*min/i) || context.match(/(\d+)\s*분/);
  if (minOnly) {
    return `${minOnly[1]}분`;
  }
  // Handle date-based resets like "Resets Mar 27, 10:00 AM" or "3월 27일 재설정"
  const dateMatch = context.match(/Resets?\s+(.+)/i);
  if (dateMatch) {
    const dateStr = dateMatch[1].trim();
    // Keep it short - just show the date part
    if (dateStr.length <= 20) return dateStr;
    return dateStr.substring(0, 20);
  }
  return '';
}

// Parse remaining minutes until reset from context strings.
// Returns null if no hr/min duration can be extracted (e.g. date-based resets).
function parseRemainingMinutes(context?: string): number | null {
  if (!context) return null;
  const enMatch = context.match(/(\d+)\s*hr?\s*(\d+)?\s*min?/i);
  if (enMatch) {
    return parseInt(enMatch[1], 10) * 60 + (enMatch[2] ? parseInt(enMatch[2], 10) : 0);
  }
  const krMatch = context.match(/(\d+)\s*시간\s*(\d+)?\s*분?/);
  if (krMatch) {
    return parseInt(krMatch[1], 10) * 60 + (krMatch[2] ? parseInt(krMatch[2], 10) : 0);
  }
  const minOnly = context.match(/(\d+)\s*min/i) || context.match(/(\d+)\s*분/);
  if (minOnly) {
    return parseInt(minOnly[1], 10);
  }
  return null;
}

// Draw a circular gauge (clock-style) as a template tray icon.
// `fraction` (0..1) is the portion filled clockwise from 12 o'clock.
// Rendered at 2x (32px) for retina; template image = alpha only, macOS tints it.
const SESSION_LENGTH_MINUTES = 5 * 60;

function createGaugeIcon(fraction: number): Electron.NativeImage {
  const size = 32;
  const center = size / 2;
  const outerR = 15;
  const innerR = 10; // ring thickness = outerR - innerR
  const f = Math.max(0, Math.min(1, fraction));
  const fillAngle = f * Math.PI * 2;

  const buffer = Buffer.alloc(size * size * 4); // transparent by default
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > outerR || dist < innerR) continue;

      // Angle clockwise from 12 o'clock (top).
      let angle = Math.atan2(dx, -dy);
      if (angle < 0) angle += Math.PI * 2;

      // Soft edge anti-aliasing on the ring borders.
      const edge = Math.min(outerR - dist, dist - innerR, 1);
      const ringAlpha = Math.max(0, Math.min(1, edge));
      // Filled portion is opaque; the rest is a faint track.
      const filled = angle <= fillAngle;
      const a = Math.round((filled ? 255 : 70) * ringAlpha);

      const i = (y * size + x) * 4;
      buffer[i] = 0;       // R (template: color ignored, alpha used)
      buffer[i + 1] = 0;   // G
      buffer[i + 2] = 0;   // B
      buffer[i + 3] = a;   // A
    }
  }

  const icon = nativeImage.createFromBuffer(buffer, { width: size, height: size, scaleFactor: 2 });
  icon.setTemplateImage(true);
  return icon;
}

function updateTrayTitle(claudeUsage: { isAuthenticated: boolean; bars?: Array<{ percentage: number; label?: string; context?: string; used?: number; limit?: number }> } | null) {
  if (!tray) return;
  if (!claudeUsage || !claudeUsage.isAuthenticated) {
    tray.setTitle('');
    return;
  }
  const sessionBar = claudeUsage.bars?.find(b =>
    b.label?.toLowerCase().includes('current session') ||
    b.label?.includes('현재 세션')
  ) || claudeUsage.bars?.[0];

  if (sessionBar !== undefined) {
    tray.setTitle(` ${sessionBar.percentage}%`);

    // Circular gauge shows remaining session time (5h max), filled clockwise.
    const remaining = parseRemainingMinutes(sessionBar.context);
    if (remaining !== null) {
      const fraction = remaining / SESSION_LENGTH_MINUTES;
      tray.setImage(createGaugeIcon(fraction));
    }
  } else {
    tray.setTitle('');
  }
}

async function refreshAllData() {
  if (!mainWindow) return;

  addLog('Refreshing data...');

  try {
    const claudeUsage = await scrapeClaudeUsage().then(result => {
      if (result) {
        if (result.isAuthenticated) {
          addLog(`Usage: ${result.bars?.length || 0} bars fetched`);
        } else {
          addLog('Usage: Not authenticated');
        }
      } else {
        addLog('Usage: Skipped (in progress)');
      }
      return result;
    }).catch(err => {
      addLog(`Usage error: ${err.message}`);
      return null;
    });

    updateTrayTitle(claudeUsage);

    if (claudeUsage?.isAuthenticated && claudeUsage.bars) {
      checkAndNotify(claudeUsage.bars);
    }

    mainWindow.webContents.send('app:data-updated', {
      claudeUsage,
      timestamp: new Date().toISOString(),
      logs: getRecentLogs(6),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog(`Refresh failed: ${message}`);
  }
}

async function getApiData(): Promise<ApiData | null> {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  console.log('getApiData called, key exists:', !!adminKey);

  if (!adminKey) {
    console.log('Admin key not configured');
    return null;
  }

  // Accept both sk-ant-admin- and sk-ant-admin01- prefixes
  if (!adminKey.startsWith('sk-ant-admin')) {
    console.log('Invalid admin key format');
    return null;
  }

  const now = new Date();
  // Use a date from 30 days ago to now - using simple date strings
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startDate = thirtyDaysAgo.toISOString().split('T')[0] + 'T00:00:00Z';
  const endDateStr = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0] + 'T00:00:00Z';

  try {
    console.log('Fetching API data from:', startDate, 'to:', endDateStr);

    const [usageReport, costReport, creditBalance] = await Promise.all([
      getUsageReport(adminKey, {
        starting_at: startDate,
        group_by: ['workspace_id', 'model'],
        limit: 31,
      }),
      getCostReport(adminKey, {
        starting_at: startDate,
        group_by: ['workspace_id'],
        limit: 31,
      }),
      getCreditBalance(adminKey).catch(err => {
        console.log('Credit balance not available:', err.message);
        return null;
      }),
    ]);

    console.log('API data fetched successfully');
    console.log('Usage buckets:', usageReport?.data?.length || 0);
    console.log('Cost buckets:', costReport?.data?.length || 0);
    console.log('Credit balance:', creditBalance?.available_credit || 'N/A');

    return { usageReport, costReport, creditBalance };
  } catch (error) {
    console.error('Error fetching API data:', error);
    throw error;
  }
}

function startAutoRefresh() {
  // Refresh every 60 seconds
  refreshInterval = setInterval(refreshAllData, 60000);
  // Initial refresh
  refreshAllData();
}

// IPC Handlers
ipcMain.handle('claude-max:get-usage', async () => {
  try {
    return await scrapeClaudeUsage();
  } catch (error) {
    console.error('Failed to get Claude usage:', error);
    return null;
  }
});

ipcMain.handle('claude-max:is-authenticated', async () => {
  return isAuthenticated();
});

ipcMain.handle('claude-max:login', async () => {
  return openLoginWindow();
});

ipcMain.handle('platform:login', async () => {
  return openPlatformLoginWindow();
});

ipcMain.handle('app:refresh-all', async () => {
  await refreshAllData();
});

ipcMain.handle('app:get-admin-key-status', () => {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  return {
    configured: !!key && key.startsWith('sk-ant-admin'),
  };
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();
  startAutoRefresh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Hide dock icon on macOS (menu bar app)
if (process.platform === 'darwin') {
  app.dock?.hide();
}
