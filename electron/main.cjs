// electron/main.cjs
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

// ── Predictable userData folder ──
app.setName('CodeTeach');
app.setPath('userData', path.join(app.getPath('appData'), 'CodeTeach'));
app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// ── Safe file logger ──
const logFile = path.join(app.getPath('userData'), 'main.log');
const DEBUG_LOG = {
  write: (m) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}`);
    } catch { /* ignore */ }
  },
};

DEBUG_LOG.write(`=== LAUNCH ===\n`);

process.on('uncaughtException', (err) => {
  DEBUG_LOG.write('UNCAUGHT: ' + (err && err.stack || err) + '\n');
});
process.on('unhandledRejection', (err) => {
  DEBUG_LOG.write('UNHANDLED REJECTION: ' + (err && err.stack || err) + '\n');
});

let mainWindow = null;
let serverProc = null;      // only used in dev mode
let __serverStarted = false;

const PORT = 8080;
const SERVER_URL = `http://localhost:${PORT}`;

async function startServer() {
  if (__serverStarted) return;

  // ── DEV: spawn tsx in a child ──
  if (!app.isPackaged) {
    DEBUG_LOG.write('DEV mode: spawning tsx\n');
    const cwd = path.join(__dirname, '..');
    const child = spawn('npx', ['tsx', '--env-file=.env', 'server/index.ts'], {
      cwd, shell: true, stdio: 'inherit',
    });
    serverProc = child;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    __serverStarted = true;
    return;
  }

  // ── PACKAGED: run the server in-process ──
  const seedDir = path.join(process.resourcesPath, 'app');
  const userDir = app.getPath('userData');
  fs.mkdirSync(userDir, { recursive: true });

  const seedDb = path.join(seedDir, 'codeteach.db');
  const userDb = path.join(userDir, 'codeteach.db');
  const seedEnv = path.join(seedDir, '.env');
  const userEnv = path.join(userDir, '.env');

  if (!fs.existsSync(userDb) && fs.existsSync(seedDb)) fs.copyFileSync(seedDb, userDb);
  if (!fs.existsSync(userEnv) && fs.existsSync(seedEnv)) fs.copyFileSync(seedEnv, userEnv);

  // Set env vars BEFORE importing the server
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(PORT);      // MUST match SERVER_URL above
  process.env.DB_PATH = userDb;
  process.env.PUBLIC_DIR = path.join(process.resourcesPath, 'app', 'public');
  process.env.DOTENV_CONFIG_PATH = userEnv;

  const serverEntry = path.join(
    process.resourcesPath, 'app', 'dist', 'server', 'index.js'
  );
  DEBUG_LOG.write(`importing ${serverEntry}\n`);
  if (!fs.existsSync(serverEntry)) {
    throw new Error('server entry not found: ' + serverEntry);
  }

  const serverModule = await import(pathToFileURL(serverEntry).href);
  await serverModule.startServer();
  __serverStarted = true;
  DEBUG_LOG.write('server started in-process\n');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: 'CodeTeach — AI Debug Tutor',
    backgroundColor: '#f6f7f9', show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(SERVER_URL);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SERVER_URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  createWindow();

  // Show a friendly loading page immediately.
  mainWindow.loadURL(
    'data:text/html,' + encodeURIComponent(`
      <html>
        <body style="font-family:-apple-system,Segoe UI,sans-serif;
                     background:#f6f7f9;display:grid;place-items:center;
                     height:100vh;margin:0;color:#1a1d23">
          <div style="text-align:center">
            <h2 style="margin:0 0 8px">Starting CodeTeach…</h2>
            <p style="color:#64748b;margin:0">First launch may take a moment.</p>
          </div>
        </body>
      </html>
    `)
  );
  mainWindow.show();

  try {
    DEBUG_LOG.write('whenReady fired\n');
    await startServer();
    mainWindow.loadURL(SERVER_URL);
  } catch (err) {
    DEBUG_LOG.write(`FAILED: ${err.stack || err}\n`);
    dialog.showErrorBox('CodeTeach failed to start', String(err.stack || err));
    app.quit();
  }
});