import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";
import { type RestockItemInput, type RestockItemOutput } from "./schema";
import { createActionResult } from "../../shared/result";
import { wallet } from "./resources";
import { addCoins } from "./server/wallet";

const DAILY_COINS = 25;

// An inputless action: the generated stub is `claimDaily()`. It changes the
// state behind the wallet resource, then invalidates it, so the caller's
// subscription has the new balance before this call resolves.
export const claimDaily = defineAction({
  id: "inventory.claimDaily",
  rateLimit: { key: "player", windowMs: 1000, max: 1 },
  output: schema.object({ coins: schema.u32() }),
  run(ctx) {
    const coins = addCoins((ctx.player as Player).UserId, DAILY_COINS);
    ctx.resources?.invalidate(wallet);
    ctx.publisher?.to(ctx.player, "inventory.dailyClaimed", { amount: DAILY_COINS });
    return { coins };
  },
});

export const restockItem = defineAction({
  id: "inventory.restockItem",
  input: schema.object({
    itemIds: schema.array(schema.string().maxLength(64)).maxItems(50),
    warehouse: schema.literal("central"),
    auditTag: schema.optional(schema.string().maxLength(64)),
  }),
  output: schema.object({
    result: schema.object({
      ok: schema.boolean(),
      reason: schema.optional(schema.string()),
    }),
    itemIds: schema.array(schema.string()),
    warnings: schema.array(schema.string()),
  }),
  run(_ctx, input): RestockItemOutput {
    const typedInput: RestockItemInput = input;
    const warnings = typedInput.auditTag === undefined ? [] : [`audit:${typedInput.auditTag}`];
    const hasItems = typedInput.itemIds[0] !== undefined;

    return {
      result: createActionResult(hasItems, hasItems ? undefined : "no items to restock"),
      itemIds: typedInput.itemIds,
      warnings,
    };
  },
});
