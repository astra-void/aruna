import type { ServerSession } from "../server/session";
import { combatModel } from "../domains/combat/model";

export const show = (session: ServerSession) => `${session.userId}:${combatModel.profile.coins}`;
