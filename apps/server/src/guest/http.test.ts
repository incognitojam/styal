import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import { readSubmission } from "./http.ts";

const submit = (fields: Record<string, string | File>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const request = HttpServerRequest.fromWeb(
    new Request("http://localhost/api/guest/messages?share=share-1", {
      method: "POST",
      body: form,
    }),
  );
  return readSubmission.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
};

it.effect("reads a guest's quotes and files from form data, keeping a JSON file a file", () =>
  Effect.gen(function* () {
    const submission = yield* submit({
      shareId: "share-1",
      text: "",
      quotes: JSON.stringify([{ messageId: "message:reply", text: "All checks pass." }]),
      file: new File(['{"a":1}'], "data.json", { type: "application/json" }),
    });
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
    assert.deepEqual(submission?.fields.quotes, [
      { messageId: MessageId.make("message:reply"), text: "All checks pass." },
    ]);
    for (const quotes of ["not json", JSON.stringify([{ messageId: "message:reply", text: "" }])]) {
      assert.isNull(yield* submit({ shareId: "share-1", text: "", quotes }));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
