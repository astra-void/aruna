// Roblox transport: the default RemoteEvent wiring, the action invoker/binder,
// and the remote-event / remote-signal primitives. Renamed from /roblox-runtime.
export * from "./runtime/roblox.js";
export * from "./runtime/roblox-action-remote.js";
export * from "./runtime/remote-event.js";
export * from "./runtime/remote-signal.js";

import type { ActionDefinition } from "./runtime/server.js";
import type { Schema } from "./schema/index.js";

// Roblox-flavored definition helpers. `defineSignal` is unchanged from
// `aruna/server` (re-exported here so action and signal definitions can share a
// single import site), while `defineAction` defaults `TPlayer` to `Player` so
// `ctx.player` is typed out of the box — no per-action
// `run(ctx: ActionRunContext<Player>, ...)` annotation. Apart from the default
// type parameter it is identical to `defineAction` from `aruna/server` and
// returns the definition untouched.
export { defineSignal } from "./signals/define-signal.js";

export function defineAction<
  TInputSchema extends Schema | undefined = undefined,
  TOutputSchema extends Schema | undefined = undefined,
  TPlayer = Player,
  TDefinition extends ActionDefinition<TInputSchema, TOutputSchema, TPlayer> = ActionDefinition<
    TInputSchema,
    TOutputSchema,
    TPlayer
  >,
>(definition: ActionDefinition<TInputSchema, TOutputSchema, TPlayer> & TDefinition): TDefinition {
  return definition;
}
