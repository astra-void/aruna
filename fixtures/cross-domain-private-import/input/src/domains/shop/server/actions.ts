import type { Slot } from "../../inventory/model";
import { ledger } from "../../inventory/server/ledger";

export function slotsOf(playerId: string): Slot | undefined {
  return ledger.has(playerId) ? { itemId: playerId, count: 1 } : undefined;
}
