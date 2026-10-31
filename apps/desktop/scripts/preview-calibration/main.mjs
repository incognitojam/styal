import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { app, BrowserWindow, nativeImage } from "electron";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopConfig from "../../src/app/DesktopConfig.ts";
import * as ElectronDialog from "../../src/electron/ElectronDialog.ts";
import * as BrowserSession from "../../src/preview/BrowserSession.ts";
import * as DesktopBrowserHost from "../../src/preview/DesktopBrowserHost.ts";
import * as PreviewManager from "../../src/preview/Manager.ts";
import * as PreviewPasskeys from "../../src/preview/Passkeys.ts";
import * as DesktopRendererHistory from "../../src/telemetry/DesktopRendererHistory.ts";
import { resolveBrowserViewportLayout } from "../../../web/src/browser/browserViewportLayout.ts";
import calibrationHtml from "./calibration.html?raw";

const outputFlag = "--calibration-output=";
const outputDir = NodeProcess.argv
  .find((argument) => argument.startsWith(outputFlag))
  ?.slice(outputFlag.length);
NodeAssert.ok(outputDir, "The launcher must supply an isolated output directory");
NodeAssert.ok(NodePath.isAbsolute(outputDir), "Calibration output must be absolute");
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.setPath("userData", NodePath.join(outputDir, "state"));
const server = NodeHttp.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(calibrationHtml);
});
let window;
const measurements = [];

const assertCorners = (name, png, tolerance = 3) => {
  const image = nativeImage.createFromBuffer(png);
  NodeAssert.ok(!image.isEmpty(), `${name}: empty capture`);
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  // Reference pixels are solid CSS colors, independent of fonts and platform
  // rasterization. Distinct corners expose both clipping and repeated tiles.
  const cornerColors = [
    [224, 32, 64],
    [32, 176, 96],
    [48, 80, 224],
    [224, 176, 32],
  ];
  for (const y of [0.05, 0.15, 0.22, 0.78, 0.85, 0.95]) {
    for (const x of [0.05, 0.15, 0.22, 0.78, 0.85, 0.95]) {
      const column = x < 0.2 ? 0 : x > 0.8 ? 1 : -1;
      const row = y < 0.2 ? 0 : y > 0.8 ? 1 : -1;
      const rgb = column >= 0 && row >= 0 ? cornerColors[row * 2 + column] : [226, 232, 240];
      const offset = (Math.floor(y * height) * width + Math.floor(x * width)) * 4;
      const actual = [pixels[offset + 2], pixels[offset + 1], pixels[offset]];
      NodeAssert.ok(
        actual.every((value, index) => Math.abs(value - rgb[index]) <= tolerance) &&
          pixels[offset + 3] === 255,
        `${name}: wrong pixel at ${x},${y}: ${actual}, expected ${rgb}`,
      );
    }
  }
  return { width, height };
};

async function run() {
  let exitCode = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 900,
      webPreferences: { webviewTag: true, backgroundThrottling: false },
    });
    const runtimeErrors = [];
    window.webContents.on("render-process-gone", (_event, details) =>
      runtimeErrors.push(details.reason),
    );
    const attached = new Promise((resolve) => {
      window.webContents.once("did-attach-webview", (_event, guest) => resolve(guest));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await window.loadURL(
      `data:text/html,${encodeURIComponent(
        `<body style="margin:0"><webview style="width:440px;height:275px" src="${origin}" webpreferences="backgroundThrottling=no"></webview></body>`,
      )}`,
    );
    const guest = await attached;
    guest.on("render-process-gone", (_event, details) => runtimeErrors.push(details.reason));
    if (guest.isLoading()) await new Promise((resolve) => guest.once("did-finish-load", resolve));

    const platform = await Effect.runPromise(HostProcess.Platform);
    const arch = await Effect.runPromise(HostProcess.Architecture);
    const environment = DesktopEnvironment.layer({
      dirname: outputDir,
      homeDirectory: outputDir,
      platform: platform,
      processArch: arch,
      appVersion: "0.0.0-calibration",
      appPath: outputDir,
      isPackaged: false,
      resourcesPath: outputDir,
      runningUnderArm64Translation: false,
    });
    const runtime = PreviewManager.layer.pipe(
      // Kept in context: agents reach the tab through this host's CDP relay.
      Layer.provideMerge(DesktopBrowserHost.layer),
      Layer.provide(BrowserSession.layer.pipe(Layer.provide(ElectronDialog.layer))),
      Layer.provide(PreviewPasskeys.layer),
      // Calibration measures captures; renderer telemetry would only add files to its artifacts.
      Layer.provide(
        Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
          register: () => Effect.void,
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
      ),
      Layer.provide(environment.pipe(Layer.provide(DesktopConfig.layerTest({})))),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* PreviewManager.PreviewManager;
          const host = yield* DesktopBrowserHost.DesktopBrowserHost;
          const tabId = "viewport-calibration";
          const serverTab = { threadId: "calibration", tabId };
          yield* manager.createTab(tabId, { serverTab });
          yield* manager.registerWebview(tabId, guest.id);
          // The relay the environment server's Playwright drives for agent snapshots and clicks.
          const replies = new Map();
          yield* host.events.pipe(
            Stream.runForEach((line) =>
              Effect.sync(() => {
                const event = JSON.parse(new TextDecoder().decode(line));
                if (event.type !== "cdp") return;
                const message = JSON.parse(event.message);
                replies.get(message.id)?.(message);
                replies.delete(message.id);
              }),
            ),
            Effect.forkScoped,
          );
          let relayId = 0;
          const relay = (method, params) =>
            Effect.promise(
              () =>
                new Promise((resolve, reject) => {
                  const id = ++relayId;
                  replies.set(id, (message) =>
                    message.error
                      ? reject(new Error(`${method}: ${message.error.message}`))
                      : resolve(message.result),
                  );
                  Effect.runFork(
                    host.handleCommandLine(
                      JSON.stringify({
                        type: "cdp",
                        ...serverTab,
                        message: JSON.stringify({
                          id,
                          method,
                          params,
                          sessionId: "t3-preview-page",
                        }),
                      }),
                    ),
                  );
                }),
            );
          // Agents drive tabs from the environment server now; the page is read here directly.
          const evaluate = (expression) =>
            Effect.promise(() => guest.executeJavaScript(expression));
          let footprint = { width: 440, height: 275 };
          const paint = () =>
            Effect.promise(async () => {
              await window.webContents.executeJavaScript(
                "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
              );
              const zoom = window.webContents.getZoomFactor();
              const expected = {
                width: Math.round(footprint.width * zoom),
                height: Math.round(footprint.height * zoom),
              };
              // Page RAF runs before native presentation. Await a compositor frame
              // at the new surface size before testing its pixels, without retries.
              await new Promise((resolve) => {
                guest.beginFrameSubscription((image) => {
                  const size = image.getSize();
                  if (
                    Math.abs(size.width - expected.width) <= 1 &&
                    Math.abs(size.height - expected.height) <= 1
                  ) {
                    guest.endFrameSubscription();
                    resolve();
                  }
                });
                guest.invalidate();
              });
            });
          const present = Effect.fn("PreviewCalibration.present")(
            function* (width, height, availableWidth, availableHeight, pageZoom) {
              const layout = resolveBrowserViewportLayout(
                { width: availableWidth, height: availableHeight },
                { _tag: "freeform", width, height },
                pageZoom,
              );
              footprint = { width: layout.viewportWidth, height: layout.viewportHeight };
              yield* Effect.promise(() =>
                window.webContents.executeJavaScript(
                  `Object.assign(document.querySelector('webview').style, ${JSON.stringify({ width: `${layout.viewportWidth}px`, height: `${layout.viewportHeight}px` })})`,
                ),
              );
              yield* manager.setViewportPresentation(tabId, {
                width,
                height,
                scale: layout.viewportScale,
              });
            },
          );
          const check = Effect.fn("PreviewCalibration.check")(function* (
            name,
            requestedWidth,
            requestedHeight,
            fitted = true,
          ) {
            yield* paint();
            const artifact = yield* manager.captureScreenshot(tabId);
            const png = yield* Effect.promise(() => NodeFSP.readFile(artifact.path));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(NodePath.join(outputDir, `${name}.png`), png),
            );
            const { width, height } = assertCorners(name, png);
            // Captured as the environment server's snapshot asks: the viewport clip, capped at
            // 1280 wide on a 2x render. An unfitted tab's capture is Chromium's own, which
            // never answers for a hidden window, so only fitted tabs are checked.
            let agentCapture = null;
            if (fitted) {
              const scale = Math.min(1, 1280 / (requestedWidth * 2));
              const relayed = yield* relay("Page.captureScreenshot", {
                format: "png",
                clip: { x: 0, y: 0, width: requestedWidth, height: requestedHeight, scale },
              });
              const agentPng = Buffer.from(relayed.data, "base64");
              yield* Effect.promise(() =>
                NodeFSP.writeFile(NodePath.join(outputDir, `${name}-agent.png`), agentPng),
              );
              // Resampled from the displayed surface, so edges blur more than a native
              // capture's. Tiling puts the wrong colors in these probes, well beyond this.
              agentCapture = assertCorners(`${name} agent snapshot`, agentPng, 8);
            }
            const point = {
              x: Math.round(requestedWidth * 0.4),
              y: Math.round(requestedHeight * 0.6),
            };
            yield* evaluate(
              "window.__clicks = []; addEventListener('click', (e) => __clicks.push([e.clientX, e.clientY]), { once: true }); 0",
            );
            for (const type of ["mousePressed", "mouseReleased"]) {
              yield* relay("Input.dispatchMouseEvent", {
                type,
                ...point,
                button: "left",
                clickCount: 1,
              });
            }
            const [clicked] = yield* evaluate("window.__clicks");
            NodeAssert.ok(
              clicked && Math.abs(clicked[0] - point.x) <= 2 && Math.abs(clicked[1] - point.y) <= 2,
              `${name}: agent click at ${point.x},${point.y} landed at ${clicked}`,
            );
            const metrics = yield* evaluate("({width:innerWidth,height:innerHeight})");
            NodeAssert.ok(
              Math.abs(metrics.width - requestedWidth) <= 1,
              `${name}: CSS width ${metrics.width}`,
            );
            NodeAssert.ok(
              Math.abs(metrics.height - requestedHeight) <= 1,
              `${name}: CSS height ${metrics.height}`,
            );
            NodeAssert.ok(
              Math.abs(width / height - requestedWidth / requestedHeight) < 0.02,
              `${name}: capture aspect ratio`,
            );
            measurements.push({
              name,
              requestedWidth,
              requestedHeight,
              metrics,
              capture: { width, height },
              agentCapture,
            });
            console.log(
              `PASS ${name}: ${metrics.width}x${metrics.height}, capture ${width}x${height}`,
            );
          });
          for (const pageZoom of [0.9, 1, 1.1]) {
            yield* manager.resetZoom(tabId);
            if (pageZoom < 1) yield* manager.zoomOut(tabId);
            if (pageZoom > 1) yield* manager.zoomIn(tabId);
            yield* present(1280, 800, 440, 275, pageZoom);
            for (const hostZoom of [0.8, 1, 1.2]) {
              window.webContents.setZoomFactor(hostZoom);
              // Exercise a host zoom change without resending the presentation.
              yield* manager.reapplyZoom();
              yield* check(`host-${hostZoom}-page-${pageZoom}`, 1280, 800);
            }
          }
          yield* manager.resetZoom(tabId);
          window.webContents.setZoomFactor(0.8);
          yield* manager.reapplyZoom();
          for (const [name, width, height, availableWidth, availableHeight] of [
            ["phone", 375, 667, 440, 275],
            ["small-preview", 1280, 800, 220, 138],
            ["resized-back", 1280, 800, 440, 275],
          ]) {
            yield* present(width, height, availableWidth, availableHeight, 1);
            yield* check(name, width, height);
          }
          // Leaving a fitted viewport must clear its CDP override too.
          window.webContents.setZoomFactor(1);
          yield* present(440, 275, 440, 275, 1);
          yield* check("natural-size", 440, 275, false);
          NodeAssert.deepEqual(runtimeErrors, []);
        }).pipe(Effect.provide(runtime)),
      ),
    );
    await NodeFSP.writeFile(
      NodePath.join(outputDir, "measurements.json"),
      JSON.stringify(measurements, null, 2),
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    server.close();
    app.exit(exitCode);
  }
}
void run();
