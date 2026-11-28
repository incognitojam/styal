import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeEvents from "node:events";
import * as NodeReadline from "node:readline";
const { chromium } = NodeModule.createRequire("/rehearsal/runtime/apps/server/dist/bin.mjs")(
  "playwright-core",
);

const browser = await chromium.launch({
  executablePath: `/rehearsal/chromium/${process.argv[2]}`,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let stopping = false;
let markReady;
let failReady;
const ready = new Promise((resolve, reject) => {
  failReady = reject;
  markReady = resolve;
});
ready.catch(() => {});
const child = NodeChildProcess.spawn(
  "/node",
  [
    "/rehearsal/runtime/apps/server/dist/bin.mjs",
    "--base-dir",
    "/rehearsal/base",
    "--host",
    "127.0.0.1",
    "--port",
    "3773",
    "--no-browser",
  ],
  { cwd: "/rehearsal", env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
const exited = NodeEvents.once(child, "exit");
NodeReadline.createInterface({ input: child.stdout }).on("line", (output) => {
  const pairing = output.match(/pairingUrl: (http:\/\/127\.0\.0\.1:3773\/pair#token=[A-Z0-9]+)/);
  if (pairing)
    page
      .goto(pairing[1])
      .then(() => page.getByRole("combobox", { name: "Search threads" }).waitFor())
      .then(markReady)
      .catch(failReady);
  process.stdout.write(
    output
      .replace(/pairingUrl: .*/g, "Pairing opened inside the isolated browser.")
      .replace(
        "Listening on http://127.0.0.1:3773",
        "Rehearsal server listening inside its network namespace",
      ) + "\n",
  );
});
child.stderr.pipe(process.stderr);
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await browser.close();
  child.kill("SIGTERM");
  await exited;
  process.exit(0);
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
child.on("error", (error) => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});
child.on("exit", (code) => {
  failReady(new Error("server-stopped"));
  if (!stopping) process.exit(code || 1);
});

// The host sees only this fixed image viewer, never copied HTML, links or scripts.
const viewer = NodeHttp.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/frame") {
      response.setHeader("Content-Type", "image/png");
      await ready;
      response.end(await page.screenshot());
    } else if (request.method === "POST" && request.url === "/input") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) throw new Error("input-too-large");
      }
      const input = JSON.parse(body);
      if (input.type === "click" && Number.isFinite(input.x) && Number.isFinite(input.y))
        await page.mouse.click(input.x, input.y);
      else if (input.type === "wheel" && Number.isFinite(input.x) && Number.isFinite(input.y))
        await page.mouse.wheel(input.x, input.y);
      else if (input.type === "key" && typeof input.key === "string" && input.key.length <= 32)
        await page.keyboard.press(input.key === " " ? "Space" : input.key);
      else if (input.type === "text" && typeof input.text === "string" && input.text.length <= 4096)
        await page.keyboard.insertText(input.text);
      else if (input.type === "back") await page.goBack();
      else if (input.type === "reload") await page.reload();
      else throw new Error("invalid-input");
      response.end();
    } else {
      response.statusCode = 404;
      response.end();
    }
  } catch {
    response.statusCode = 503;
    response.end("Rehearsal browser unavailable");
  }
});
viewer.listen(3774, "127.0.0.1");
await NodeEvents.once(viewer, "listening");
function channel() {
  const stream = NodeNet.createConnection("/rehearsal/control/s");
  let paired = false;
  stream.on("error", (error) => {
    if (!paired && !stopping) {
      process.stderr.write(String(error) + "\n");
      process.exit(1);
    }
  });
  stream.once("data", (chunk) => {
    paired = true;
    if (chunk[0] === 83) {
      void stop();
      return;
    }
    channel();
    if (chunk.length > 1) stream.unshift(chunk.subarray(1));
    const upstream = NodeNet.createConnection({ host: "127.0.0.1", port: 3774 });
    upstream.on("error", () => stream.destroy());
    stream.on("close", () => upstream.destroy());
    upstream.on("close", () => stream.destroy());
    stream.pipe(upstream).pipe(stream);
  });
}
channel();
