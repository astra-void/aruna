// Server hook module (entries: "generated"): the generated
// src/.aruna/server/main.server.ts owns the app bootstrap and wires these
// exports into createServerApp.
import type { ActionErrorHandler, ActionMiddleware, ServerApp } from "aruna/server";

// roblox-ts reserves the identifiers `next` and `error` for compiler
// internal usage, so the middleware/error-handler params use other names.
export const middleware: ActionMiddleware<Player>[] = [
	(info, proceed) => {
		print(`[harness] dispatch ${info.actionId}`);
		return proceed();
	},
];

export const onError: ActionErrorHandler<Player> = (err, info) => {
	print(`[harness] action ${info.actionId} failed: ${tostring(err)}`);
};

export function configure(_app: ServerApp<Player>) {
	print("[harness] server app configured");
}
