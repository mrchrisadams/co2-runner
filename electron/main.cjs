// electron/main.cjs — Electron shell for the CO2 Runner desktop app.
//
// The BrowserWindow is UI only: it loads the dashboard served by the Hono
// server on 127.0.0.1. Journeys are still measured in Firefox via Playwright
// (spawned by the server child), never in this window.
//
// Wiring: on ready, pick a free loopback port, spawn the server as
// `<execPath> <tsx-cli> main.ts serve` with ELECTRON_RUN_AS_NODE=1 so the
// Electron binary acts as plain Node (the same trick the Playwright CLI
// subprocesses rely on), point CO2_RUNNER_DESKTOP_ADDRESS and PORT at the
// chosen port, poll the dashboard URL until it answers, then load it.

const { app, BrowserWindow, Menu, dialog } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..");
const SERVER_TIMEOUT_MS = 15000;
const TERM_GRACE_MS = 3000;

let server = null;
let address = null;
let quitting = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// tsx's CLI entry, resolved from the app's own node_modules (packaged apps
// ship tsx as a production dependency so node_modules pruning keeps it).
function tsxCliPath() {
  try {
    return require.resolve("tsx/cli");
  } catch {
    return path.join(APP_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

// The server child preloads this watchdog so it exits if the shell dies
// without a graceful quit (signals sent to this process never reach it).
function watchdogPath() {
  return path.join(__dirname, "server-watchdog.cjs");
}

function startServer(port) {
  address = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [tsxCliPath(), "main.ts", "serve"],
    {
      cwd: APP_ROOT,
      detached: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: `--require "${watchdogPath()}"`,
        PORT: String(port),
        CO2_RUNNER_DESKTOP_ADDRESS: address,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  child.once("error", (err) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox(
        "CO2 Runner",
        `Could not start the background server: ${err.message}`,
      );
      app.quit();
    }
  });
  child.once("exit", (code, signal) => {
    server = null;
    if (!quitting && !signal) {
      dialog.showErrorBox(
        "CO2 Runner",
        `The background server exited unexpectedly (exit code ${code}).`,
      );
      app.quit();
    }
  });
  return child;
}

async function waitForServer(url) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet — poll again
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `server did not answer ${url} within ${SERVER_TIMEOUT_MS / 1000}s`,
  );
}

function killServer() {
  return new Promise((resolve) => {
    const child = server;
    server = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once("exit", finish);
    // The server runs detached in its own process group (tsx → playwright →
    // firefox), so a group signal is the only way to reach the whole tree —
    // a bare child.kill() would orphan a mid-journey Firefox.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      if (!settled) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        setTimeout(finish, 500);
      }
    }, TERM_GRACE_MS);
  });
}

function createWindow(url) {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({ width: 1200, height: 800 });
  win.webContents.on("did-finish-load", () => {
    console.log(`[window] loaded ${url}`);
  });
  win.webContents.on("did-fail-load", (_event, code, desc) => {
    console.error(`[window] load failed: ${code} ${desc}`);
  });
  win.loadURL(url).catch((err) => {
    dialog.showErrorBox("CO2 Runner", `Could not load ${url}: ${err.message}`);
    app.quit();
  });
  return win;
}

app.whenReady().then(async () => {
  try {
    const port = await freePort();
    server = startServer(port);
    console.log(`[shell] server child pid ${server.pid} on ${address}`);
    await waitForServer(address);
  } catch (err) {
    dialog.showErrorBox(
      "CO2 Runner failed to start",
      String(err.message ?? err),
    );
    app.quit();
    return;
  }
  createWindow(address);
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  killServer().finally(() => app.quit());
});
