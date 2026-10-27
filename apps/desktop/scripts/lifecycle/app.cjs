const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { app, ipcMain } = require("electron");

const outputDir = process.env.STYAL_LIFECYCLE_SAMPLE;
if (!outputDir) throw new Error("Run through measure-lifecycle.mjs");
const startedAt = performance.now() - process.uptime() * 1000;
const report = (event, attributes = {}) =>
  process.send?.({ event, elapsedMs: performance.now() - startedAt, ...attributes });

// Capture only PIDs spawned by this app, so a failed sample can clean up its own backend.
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  const backend =
    args[1]?.includes(path.resolve(__dirname, "../../../server/dist/bin.mjs")) ?? false;
  child.once("spawn", () => report("child-spawned", { pid: child.pid, backend }));
  child.once("exit", (code, signal) =>
    report("child-exited", { pid: child.pid, backend, code, signal }),
  );
  return child;
};

app.setPath("userData", path.join(process.env.STYAL_HOME, "electron"));
app.on("browser-window-created", (_event, window) => {
  report("window-created");
  window.once("show", () => report("window-shown"));
  window.webContents.once("did-finish-load", () => report("renderer-loaded"));
  window.webContents.on("render-process-gone", (_event, details) =>
    report("renderer-crashed", { reason: details.reason }),
  );
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") {
      fs.appendFileSync(path.join(outputDir, "renderer-errors.log"), `${event.message}\n`);
      report("renderer-error");
    }
  });
});

// The existing readiness signal requires a connection, server config, and a shell snapshot.
// Observe its real handler instead of treating did-finish-load as a usable application.
const handle = ipcMain.handle.bind(ipcMain);
let ready = false;
ipcMain.handle = (channel, listener) =>
  handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === "desktop:app-activation-ready" && args[1] === true && !ready) {
      ready = true;
      report("ui-ready");
    }
    return result;
  });
process.on("message", (message) => {
  if (message === "quit" && ready) {
    report("quit-requested");
    app.quit();
  }
});
app.on("will-quit", () => report("will-quit"));
app.on("quit", (_event, exitCode) => report("quit", { exitCode }));
process.on("uncaughtException", (error) => {
  fs.writeFileSync(path.join(outputDir, "uncaught-error.txt"), error.stack ?? String(error));
  report("uncaught-error");
  app.exit(1);
});
require("../../dist-electron/boot.cjs");
report("bundle-loaded");
