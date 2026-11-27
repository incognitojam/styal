import * as Schema from "effect/Schema";

export class InventoryRefusal extends Schema.TaggedError<InventoryRefusal>()("InventoryRefusal", {
  category: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.category;
  }
}

export const isInventoryRefusal = Schema.is(InventoryRefusal);
