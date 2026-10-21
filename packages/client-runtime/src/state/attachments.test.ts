import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type AttachmentCreateUploadUrlInput,
  type AttachmentCreateUploadUrlResult,
  type AttachmentDeleteInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import type { AtomCommand } from "./runtime.ts";
import {
  attachmentBatchLimitError,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "./attachments.ts";

const environmentId = EnvironmentId.make("environment-1");
const registry = {} as AtomRegistry.AtomRegistry;

type CreateUploadUrlCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentCreateUploadUrlInput },
  AttachmentCreateUploadUrlResult,
  never
>;

type RemoveCommand = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: AttachmentDeleteInput },
  unknown,
  never
>;

function makeCreateUploadUrl(attachmentId: string): CreateUploadUrlCommand {
  return {
    label: "test:create-upload-url",
    run: async () =>
      AsyncResult.success<AttachmentCreateUploadUrlResult, never>({
        attachmentId,
        relativeUrl: `/api/attachments/upload/${attachmentId}`,
        expiresAt: 1,
      }),
  };
}

const removeCalls: string[] = [];
const remove: RemoveCommand = {
  label: "test:remove",
  run: async (_registry, input) => {
    removeCalls.push(input.input.attachmentId);
    return AsyncResult.success(undefined);
  },
};

const uploadInput: AttachmentCreateUploadUrlInput = {
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
};

describe("runAttachmentUploadCycle", () => {
  it("deletes the fresh mint when the caller cancels at onMinted", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-cancelled"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run after cancel");
      },
      onMinted: () => "cancel",
    });

    expect(result).toEqual({ status: "cancelled", attachmentId: "pending-cancelled" });
    expect(removeCalls).toEqual(["pending-cancelled"]);
  });

  it("keeps the minted id on transfer failure so the caller can retry or release", async () => {
    removeCalls.length = 0;
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: makeCreateUploadUrl("pending-failed"),
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => ({
        done: Promise.reject(new Error("Upload rejected (413)")),
        abort: () => {},
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      step: "transfer",
      attachmentId: "pending-failed",
    });
    expect(removeCalls).toEqual([]);
  });

  it("reports an interrupted upload URL request as not connected", async () => {
    const result = await runAttachmentUploadCycle({
      registry,
      createUploadUrl: {
        label: "test:create-upload-url",
        run: async () => AsyncResult.failure(Cause.interrupt()),
      },
      remove,
      environmentId,
      upload: uploadInput,
      resolveUploadUrl: () => "https://environment.test/upload",
      transport: () => {
        throw new Error("transport must not run without a mint");
      },
    });

    expect(result).toMatchObject({ status: "failed", step: "mint", attachmentId: null });
    const error = result.status === "failed" ? result.error : undefined;
    expect(error).toBeInstanceOf(Error);
    expect(isTransportConnectionErrorMessage((error as Error).message)).toBe(true);
  });
});

describe("verifyPersistedAttachmentUpload", () => {
  it("hits the server on every verification instead of reusing a cached failure", async () => {
    let lookups = 0;
    const assetUrlAtom = Atom.make(
      Effect.promise(() => Promise.resolve()).pipe(
        Effect.flatMap(() => {
          lookups += 1;
          return lookups === 1
            ? Effect.fail({ _tag: "TransportError" } as const)
            : Effect.succeed({ url: "/api/assets/pending-1" });
        }),
      ),
    ).pipe(Atom.swr({ staleTime: 60_000 }), Atom.keepAlive);
    const liveRegistry = AtomRegistry.make();

    const verify = () =>
      verifyPersistedAttachmentUpload({
        registry: liveRegistry,
        createAssetUrl: () => assetUrlAtom,
        environmentId,
        attachmentId: "pending-1",
      });

    const first = await verify();
    expect(first).toMatchObject({ status: "failed" });

    const second = await verify();
    expect(second).toEqual({ status: "verified" });
    expect(lookups).toBe(2);
  });

  it("reports an interrupted upload lookup as not connected", async () => {
    const result = await verifyPersistedAttachmentUpload({
      registry: AtomRegistry.make(),
      createAssetUrl: () => Atom.make(Effect.interrupt),
      environmentId,
      attachmentId: "pending-1",
    });

    expect(result).toMatchObject({ status: "failed" });
    const error = result.status === "failed" ? result.error : undefined;
    expect(error).toBeInstanceOf(Error);
    expect(isTransportConnectionErrorMessage((error as Error).message)).toBe(true);
  });
});

describe("attachmentBatchLimitError", () => {
  it("accepts eight attachments at the aggregate byte boundary", () => {
    expect(
      attachmentBatchLimitError(
        Array.from({ length: 8 }, () => ({ sizeBytes: (50 * 1024 * 1024) / 8 })),
      ),
    ).toBeNull();
  });
  it("rejects the whole batch when one byte over the aggregate limit", () => {
    expect(
      attachmentBatchLimitError([
        { sizeBytes: 10 * 1024 * 1024 },
        { sizeBytes: 40 * 1024 * 1024 + 1 },
      ]),
    ).toBe("Attachments can total at most 50 MB per message.");
  });
  it("rejects an over-count restored draft even with tiny attachments", () => {
    expect(attachmentBatchLimitError(Array.from({ length: 101 }, () => ({ sizeBytes: 1 })))).toBe(
      "Messages can contain at most 100 attachments.",
    );
  });
});
