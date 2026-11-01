// Aruna roblox-ts native runtime — `aruna/ui`: resources and actions in a
// component (docs/rfcs/ui-bindings.md).
//
// A renderer-agnostic core, and thin adapters that take the renderer as an
// argument: `createReactBindings(React)`, `createVideBindings({ source, cleanup,
// batch })`. Aruna never imports a renderer.

export { observeAction, observeResource, peekResource } from "./ui-core";
export type {
	ActionObservation,
	ActionSnapshot,
	ActionStateOptions,
	ActionStatus,
	ObserveResourceOptions,
	ResourceObservation,
	ResourceView,
} from "./ui-core";
export type { ActionCall, ActionStubInput, ActionStubOutput, AnyActionStub } from "./client-runtime";
export type { OptimisticUpdate } from "./optimistic";

export { createReactBindings } from "./ui-react";
export type { ActionState, ReactBindings, ReactBindingsOptions, ReactHooks } from "./ui-react";

export { createVideBindings } from "./ui-vide";
export type {
	ActionSources,
	ResourceSources,
	VideBindings,
	VideBindingsOptions,
	VideFunctions,
} from "./ui-vide";
