// Type-level assertions for the public subpaths, checked by
// `tsc -p tsconfig.roblox.json` (rbxts ambient types, noLib). The runtime is the
// roblox-ts-native one: these are the declarations every consumer gets, with or
// without the doctor aliases. Imports go through the same barrels the subpaths
// export (roblox/<subpath>.ts). Lives outside roblox/ so it is never vendored
// into consumers.
import { createClientApp } from "../roblox/client";
import {
	bindActions,
	createActionInvoker,
	defineAction as defineRobloxAction,
} from "../roblox/roblox";
import {
	createActionDefiner,
	createPlayerStore,
	createServerApp,
	defineAction,
	defineSignal,
	type ActionMap,
	type ActionRateLimitKeyFn,
	type ActionRateLimitOptions,
	type InferInput,
	type InferOutput,
	type ServerAppBinding,
} from "../roblox/server";
import { schema, type Infer } from "../roblox/schema";

type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

// --- Schema inference ---------------------------------------------------------
const stringSchema = schema.string();
const numberSchema = schema.number();
const booleanSchema = schema.boolean();
const literalSchema = schema.literal("sword");
const optionalSchema = schema.optional(schema.string());
const arraySchema = schema.array(schema.string());
const enumSchema = schema.enum(["a", "b"] as const);
const recordSchema = schema.record(schema.number());
const tupleSchema = schema.tuple([schema.string(), schema.number()]);
const objectSchema = schema.object({
	itemId: schema.string(),
	quantity: schema.number(),
	note: schema.optional(schema.string()),
});

type _StringSchema = Expect<Equal<Infer<typeof stringSchema>, string>>;
type _NumberSchema = Expect<Equal<Infer<typeof numberSchema>, number>>;
type _BooleanSchema = Expect<Equal<Infer<typeof booleanSchema>, boolean>>;
type _LiteralSchema = Expect<Equal<Infer<typeof literalSchema>, "sword">>;
type _OptionalSchema = Expect<Equal<Infer<typeof optionalSchema>, string | undefined>>;
type _ArraySchema = Expect<Equal<Infer<typeof arraySchema>, string[]>>;
type _EnumSchema = Expect<Equal<Infer<typeof enumSchema>, "a" | "b">>;
type _RecordSchema = Expect<Equal<Infer<typeof recordSchema>, Record<string, number>>>;
type _TupleSchema = Expect<Equal<Infer<typeof tupleSchema>, [string, number]>>;
type _ObjectSchema = Expect<
	Equal<
		Infer<typeof objectSchema>,
		{
			itemId: string;
			quantity: number;
			note?: string | undefined;
		}
	>
>;

// --- Action definitions -------------------------------------------------------
const purchaseItem = defineAction({
	id: "shop.purchaseItem",
	rateLimit: {
		key: "player",
		windowMs: 1000,
		max: 5,
	},
	input: schema.object({
		itemId: schema.string(),
		quantity: schema.number(),
	}),
	output: schema.object({
		ok: schema.boolean(),
	}),
	run(ctx, input) {
		type _RunInput = Expect<
			Equal<
				typeof input,
				{
					itemId: string;
					quantity: number;
				}
			>
		>;
		return { ok: true };
	},
});

const noSchemaAction = defineAction({
	id: "shop.noSchema",
	run(ctx, input) {
		type _NoSchemaInput = Expect<Equal<typeof input, unknown>>;
		// The generic `defineAction` from `aruna/server` leaves `TPlayer` as
		// `unknown`, so `ctx.player` needs an annotation to be Player-typed.
		type _ServerCtxPlayer = Expect<Equal<typeof ctx.player, unknown>>;
		return undefined;
	},
});

// The Roblox-flavored `defineAction` from `aruna/roblox` defaults `TPlayer` to
// `Player`, so `ctx.player` is `Player` with no annotation.
defineRobloxAction({
	id: "shop.robloxPlayer",
	input: schema.object({ amount: schema.number() }),
	run(ctx, input) {
		type _RobloxCtxPlayer = Expect<Equal<typeof ctx.player, Player>>;
		type _RobloxInput = Expect<Equal<typeof input, { amount: number }>>;
		return undefined;
	},
});

const actions = {
	"shop.purchaseItem": purchaseItem,
	"shop.noSchema": noSchemaAction,
};

type _PurchaseItemInput = Expect<
	Equal<
		InferInput<NonNullable<(typeof purchaseItem)["input"]>>,
		{
			itemId: string;
			quantity: number;
		}
	>
>;
type _PurchaseItemOutput = Expect<
	Equal<InferOutput<NonNullable<(typeof purchaseItem)["output"]>>, { ok: boolean }>
>;
type _NoSchemaActionInput = Expect<Equal<InferInput<(typeof noSchemaAction)["input"]>, unknown>>;
type _RegistryAction = Expect<Equal<(typeof actions)["shop.purchaseItem"], typeof purchaseItem>>;

// --- Apps and transport -------------------------------------------------------
const clientApp = createClientApp({
	transport: () => Promise.resolve({ ok: true }),
});
const serverApp = createServerApp({ actions });

// The app hands back the map erased to `ActionMap` (the Node runtime's types kept
// the literal map; native never did).
type _AppActions = Expect<Equal<typeof serverApp.actions, ActionMap<unknown>>>;
type _ClientDispose = Expect<Equal<typeof clientApp.dispose, () => void>>;
type _ClientOptionsNoAny = Expect<Equal<IsAny<Parameters<typeof createClientApp>[0]>, false>>;
type _ServerOptionsNoAny = Expect<Equal<IsAny<Parameters<typeof createServerApp>[0]>, false>>;
// Mutual assignability rather than `Equal`: the rbxts `Promise` declaration does
// not compare as identical to itself under the strict check.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _ServerDispatch = Expect<
	MutuallyAssignable<ReturnType<typeof serverApp.dispatch>, Promise<unknown>>
>;
type _RateLimitOptionsNoAny = Expect<Equal<IsAny<ActionRateLimitOptions>, false>>;
type _RateLimitKeyFnNoAny = Expect<Equal<IsAny<ActionRateLimitKeyFn>, false>>;
type _DefaultInvokerOptionsNoAny = Expect<
	Equal<IsAny<Parameters<typeof createActionInvoker>[0]>, false>
>;
type _DefaultBinding = Expect<Equal<ReturnType<typeof bindActions>, ServerAppBinding>>;

// --- A registry-typed publisher on the action ctx -----------------------------
// A `createActionDefiner`-bound `defineAction` makes `ctx.publisher` non-optional
// and checks `to/toMany/toAll` against the real signal ids and payloads.
const signalRegistryForTypes = {
	scoreChanged: defineSignal({
		id: "scoreChanged",
		payload: schema.object({ score: schema.number() }),
	}),
};

// The id must stay the literal from the call site, not widen to `string` —
// consumers key publishes/subscribes off `definition.id`.
type _SignalIdStaysLiteral = Expect<
	Equal<(typeof signalRegistryForTypes)["scoreChanged"]["id"], "scoreChanged">
>;
const bareSignal = defineSignal({ id: "match.started" });
type _BareSignalIdStaysLiteral = Expect<Equal<typeof bareSignal.id, "match.started">>;

const definePublishingAction = createActionDefiner<typeof signalRegistryForTypes, Player>();

definePublishingAction({
	id: "score.bump",
	input: schema.object({ amount: schema.number() }),
	run(ctx, input) {
		// No optional chaining required: the publisher is guaranteed present.
		ctx.publisher.toAll("scoreChanged", { score: input.amount });
		ctx.publisher.to(ctx.player, "scoreChanged", { score: input.amount });
		// @ts-expect-error unknown signal id
		ctx.publisher.toAll("doesNotExist", { score: 1 });
		// @ts-expect-error payload does not match the signal's schema
		ctx.publisher.toAll("scoreChanged", { score: "not a number" });
		return undefined;
	},
});

// The base `defineAction` ctx exposes the publisher optionally (an app may own
// none), so it must be accessed with optional chaining.
defineAction({
	id: "score.peek",
	run(ctx) {
		ctx.publisher?.toAll("anything", {});
		return undefined;
	},
});

// --- An app that owns a player store ------------------------------------------
// `createServerApp` names the store with its schema erased, so a concretely-typed
// `PlayerStore` must flow into `playerStore` without a cast, and
// `app.playerStore` must come back usable.
const profileSchema = schema.object({ coins: schema.number() });

const profileStore = createPlayerStore<typeof profileSchema, Player>({
	id: "player.profile",
	schema: profileSchema,
	defaultValue: { coins: 0 },
});

const appWithPlayerStore = createServerApp<Player>({
	actions: {},
	playerStore: profileStore,
});

appWithPlayerStore.playerStore?.saveAll();

export {};
