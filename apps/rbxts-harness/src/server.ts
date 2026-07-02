import { createServerApp } from "aruna/server";
import { robloxRemoteEvent } from "aruna/roblox";
import { actions, defaultRateLimit } from "$aruna/actions/server";

export function startServerApp() {
  return createServerApp<Player>({
    actions,
    defaultRateLimit,
    transport: robloxRemoteEvent(),
  });
}

startServerApp();
