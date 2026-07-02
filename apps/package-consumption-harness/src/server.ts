import { createServerApp } from "aruna/server";
import { robloxRemoteEvent } from "aruna/roblox";
import { actions } from "$aruna/actions/server";

export function startServerApp() {
  return createServerApp<Player>({
    actions,
    transport: robloxRemoteEvent(),
  });
}

startServerApp();
