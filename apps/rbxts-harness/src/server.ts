import { createServerApp } from "aruna/server-app";
import { bindDefaultRobloxActionRemoteEvent } from "aruna/roblox-runtime";
import { actions, defaultRateLimit } from "$aruna/actions/server";

export function startServerApp() {
  const serverApp = createServerApp<Player>({ actions, defaultRateLimit });

  return serverApp.bind((registry) => {
    return bindDefaultRobloxActionRemoteEvent(registry);
  });
}

startServerApp();
