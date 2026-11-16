// @effect-diagnostics nodeBuiltinImport:off -- Exercises the pinned native HTTPS transport with controlled responses.
import * as NodeHttps from "node:https";
import * as NodeEvents from "node:events";
import type * as NodeHttp from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";
import { publicAddresses } from "@t3tools/shared/publicAddresses";
import { gitHubPreviewFetch } from "./gitHubPreviewFetch.ts";

vi.mock("node:https", () => ({ get: vi.fn() }));
vi.mock("@t3tools/shared/publicAddresses", () => ({ publicAddresses: vi.fn() }));

function setup(
  responses: { status?: number; headers?: Record<string, string>; bytes?: Uint8Array }[],
) {
  vi.mocked(publicAddresses)
    .mockReset()
    .mockResolvedValue([{ address: "140.82.112.3", family: 4 }]);
  vi.mocked(NodeHttps.get)
    .mockReset()
    .mockImplementation((...args) => {
      const [, , callback] = args as [
        URL,
        NodeHttps.RequestOptions,
        (response: NodeHttp.IncomingMessage) => void,
      ];
      const fixture = responses.shift()!;
      const response = Object.assign(new NodeEvents.EventEmitter(), {
        statusCode: fixture.status ?? 200,
        headers: fixture.headers ?? { "content-type": "image/png" },
        destroy: vi.fn(),
      });
      queueMicrotask(() => {
        callback(response as unknown as NodeHttp.IncomingMessage);
        response.emit("data", fixture.bytes ?? Buffer.from("image"));
        response.emit("end");
      });
      return new NodeEvents.EventEmitter() as NodeHttp.ClientRequest;
    });
}

const source = "https://github.com/user-attachments/assets/synthetic";

describe("GitHub preview transport", () => {
  it("pins every connection and strips credentials on the observed GitHub storage redirect", async () => {
    setup([
      {
        status: 302,
        headers: {
          location:
            "https://github-production-user-asset-6210df.s3.amazonaws.com/123/456-synthetic.png?signature=synthetic",
        },
      },
      {},
    ]);
    const result = await gitHubPreviewFetch(source, "synthetic", new AbortController().signal);
    expect(result.bytes).toEqual(Buffer.from("image"));
    const calls = vi.mocked(NodeHttps.get).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toMatchObject({
      agent: false,
      headers: { authorization: "Bearer synthetic" },
    });
    expect((calls[1]![1] as NodeHttps.RequestOptions).headers).not.toHaveProperty("authorization");
    const lookup = (calls[1]![1] as NodeHttps.RequestOptions).lookup!;
    const resolved = vi.fn();
    lookup("ignored.example", { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [{ address: "140.82.112.3", family: 4 }]);
    expect(publicAddresses).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://github.com/a",
    "https://other.s3.amazonaws.com/123/456.png",
    "https://github.com:444/a",
    "https://user:secret@github.com/a",
  ])("rejects disallowed redirect %s", async (location) => {
    setup([{ status: 302, headers: { location } }]);
    await expect(gitHubPreviewFetch(source, null, new AbortController().signal)).rejects.toThrow(
      "Unsupported destination",
    );
    expect(NodeHttps.get).toHaveBeenCalledTimes(1);
  });

  it("rejects non-public DNS results before connecting and enforces streamed byte limits", async () => {
    setup([{}]);
    vi.mocked(publicAddresses).mockResolvedValueOnce(undefined);
    await expect(gitHubPreviewFetch(source, null, new AbortController().signal)).rejects.toThrow(
      "Non-public destination",
    );
    expect(NodeHttps.get).not.toHaveBeenCalled();
    setup([{ bytes: new Uint8Array(21 * 1024 * 1024) }]);
    // The real response emits its error on destroy; the fixture supplies the same event.
    vi.mocked(NodeHttps.get).mockImplementationOnce((...args) => {
      const [, , callback] = args as [
        URL,
        NodeHttps.RequestOptions,
        (response: NodeHttp.IncomingMessage) => void,
      ];
      const response = Object.assign(new NodeEvents.EventEmitter(), {
        statusCode: 200,
        headers: {},
        destroy(error: Error) {
          response.emit("error", error);
        },
      });
      queueMicrotask(() => {
        callback(response as unknown as NodeHttp.IncomingMessage);
        response.emit("data", Buffer.alloc(21 * 1024 * 1024));
      });
      return new NodeEvents.EventEmitter() as NodeHttp.ClientRequest;
    });
    await expect(gitHubPreviewFetch(source, null, new AbortController().signal)).rejects.toThrow(
      "Source too large",
    );
  });
});
