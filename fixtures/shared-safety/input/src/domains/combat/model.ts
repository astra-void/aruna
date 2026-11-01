import { profile } from "../economy/model";
import type { ServerSession } from "../../server/session";

export const combatModel = { profile };
export type CombatView = { session: ServerSession };
