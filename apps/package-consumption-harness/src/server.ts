import { createServerApp } from "aruna/server";
import { bindActions } from "aruna/roblox";
import { actions } from "$aruna/actions/server";

export function startServerApp() {
  const serverApp = createServerApp<Player>({ actions });

  return serverApp.bind((registry) => {
    return bindActions(registry);
  });
}

startServerApp();
