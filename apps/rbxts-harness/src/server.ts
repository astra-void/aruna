import { createServerApp } from "aruna/server-app";
import { bindDefaultRobloxActionRemoteEvent } from "aruna/roblox-runtime";
import { actions } from "$aruna/actions/server";

export function startServerApp() {
  const serverApp = createServerApp<Player>({ actions });

  return serverApp.bind((registry) => {
    return bindDefaultRobloxActionRemoteEvent(registry);
  });
}

startServerApp();
