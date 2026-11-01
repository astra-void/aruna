// A server-owned resource (docs/resources.md): each player observes their own
// wallet, and every change reaches them through invalidation, never a write.
import { defineResource } from "aruna/roblox";
import { walletSchema } from "./schema";
import { coinsOf } from "./server/wallet";

export const wallet = defineResource({
  id: "inventory.wallet",
  schema: walletSchema,
  load(ctx) {
    return { coins: coinsOf(ctx.player.UserId) };
  },
});
