// These guards run on the raw Node HTTP server before Effect handles requests.
// @effect-diagnostics nodeBuiltinImport:off
import { STARTUP_COPY_MESSAGE, type ServerStartupCopyProgress } from "@t3tools/contracts";
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (_request, response) => {
    response.on("error", (error) => {
      onError?.(error);
    });
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
  });
  return server;
}

/**
 * NodeHttpServer listens before serve() attaches its handlers, so requests in
 * between would hang. Install this after the write-error guards so only the
 * serving handlers trigger the handoff.
 */
export function rejectRequestsUntilServing<T extends NodeHttp.Server>(
  server: T,
  startupCopy: () => ServerStartupCopyProgress | null = () => null,
): T {
  const rejectRequest = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const copy = startupCopy();
    if (copy === null) {
      response.writeHead(503, { "retry-after": "1", connection: "close" }).end();
      return;
    }
    if (request.headers.accept?.includes("text/html")) {
      const percent = `${Math.min(100, Math.floor((copy.copiedBytes / copy.totalBytes) * 100))}%`;
      response
        .writeHead(503, {
          "retry-after": "2",
          connection: "close",
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(
          `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>Starting styal</title></head><body style="font:16px system-ui;text-align:center;margin:20vh auto;max-width:32em"><p>${STARTUP_COPY_MESSAGE}</p><p>${percent}</p></body></html>`,
        );
      return;
    }
    response
      .writeHead(503, {
        "retry-after": "1",
        connection: "close",
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify({ starting: true, copy }));
  };
  const rejectUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  server.on("request", rejectRequest);
  server.on("upgrade", rejectUpgrade);
  // Node emits newListener before adding the handler, making the handoff synchronous.
  server.on("newListener", function onNewListener(event) {
    if (event === "request") server.off("request", rejectRequest);
    if (event === "upgrade") server.off("upgrade", rejectUpgrade);
    if (
      !server.listeners("request").includes(rejectRequest) &&
      !server.listeners("upgrade").includes(rejectUpgrade)
    ) {
      server.off("newListener", onNewListener);
    }
  });
  return server;
}
