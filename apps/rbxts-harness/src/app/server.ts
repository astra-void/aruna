import { createServerApp } from "aruna/server-app";
import { bindRemoteEventActions } from "aruna/roblox-runtime";
import { actions } from "$aruna/actions/server";
import { actionRemoteEventServer } from "../shared/remotes";

export const serverApp = createServerApp<Player>({ actions });

export const serverBinding = serverApp.bind((registry) =>
  bindRemoteEventActions(actionRemoteEventServer, registry, {
    createContext: (player) => {
      return { player };
    },
  }),
);
