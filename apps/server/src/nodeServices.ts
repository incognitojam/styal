import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as Layer from "effect/Layer";

export const layer = PhysicalFileSystem.layerFileSystem.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PhysicalFileSystem.layer)),
);
