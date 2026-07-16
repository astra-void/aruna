// Roblox transport: the default RemoteEvent wiring, the action invoker/binder,
// and the remote-event / remote-signal primitives. Renamed from /roblox-runtime.
export * from "./runtime/roblox-action-remote.js";
export * from "./runtime/roblox-signal-remote.js";
// The wire-shape types and the raw invoker stay public for tooling/tests;
// `bindRemoteEventActions` is internal — `bindActions` / `robloxRemoteEvent`
// (matching the native runtime) are the public server binding surface.
export {
  DEFAULT_ACTION_REQUEST_TIMEOUT_MS,
  TimeoutError,
  createRemoteEventActionInvoker,
  type ActionContextFactory,
  type ActionInvokerOptions,
  type ActionTimeoutCanceler,
  type ActionTimeoutScheduler,
  type BindActionsOptions,
  type DisposableActionInvoker,
  type RemoteEventActionErrorPayload,
  type RemoteEventActionRequest,
  type RemoteEventActionResponse,
  type RemoteEventClientLike,
  type RemoteEventRequestIdFactory,
  type RemoteEventServerLike,
  type RemoteEventSignalConnectionLike,
  type RemoteEventSignalLike,
} from "./runtime/remote-event.js";
export * from "./runtime/remote-signal.js";

import type { ActionDefinition, PublishingActionDefinition } from "./actions/define-action.js";
import type { SignalRegistry } from "./runtime/signal.js";
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

// `createActionDefiner` flavored for Roblox: `TPlayer` defaults to `Player`, to
// match this surface's `defineAction`. Otherwise identical to the one on
// `aruna/server` — binds a `defineAction` to your signal registry so an action's
// `ctx.publisher.to/toMany/toAll(...)` is checked against the real signal ids and
// payloads, with the publisher present (no `?`) and still injected by the app.
export function createActionDefiner<TSignals extends SignalRegistry, TPlayer = Player>() {
  return function definePublishingAction<
    TInputSchema extends Schema | undefined = undefined,
    TOutputSchema extends Schema | undefined = undefined,
  >(
    definition: PublishingActionDefinition<TInputSchema, TOutputSchema, TPlayer, TSignals>,
  ): ActionDefinition<TInputSchema, TOutputSchema, TPlayer, TSignals> {
    return definition;
  };
}
