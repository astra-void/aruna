import { defineSignal } from "aruna/server";
import { dailyClaimedPayload } from "./schema";

export const dailyClaimed = defineSignal({
  id: "inventory.dailyClaimed",
  payload: dailyClaimedPayload,
});
