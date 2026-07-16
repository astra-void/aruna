import { createClientApp } from "../src/client.js";
import { defineConfig } from "../src/index.js";
import {
  bindActions,
  createRemoteEventActionInvoker,
  createActionInvoker,
  defineAction as defineRobloxAction,
  type DisposableActionInvoker,
  type RemoteEventClientLike,
} from "../src/roblox.js";
import { createServerApp } from "../src/server.js";
import { defineAction } from "../src/server.js";
import { createActionDefiner, defineSignal } from "../src/server.js";
import { type ServerBinding } from "../src/runtime/binding.js";
import { schema, type Infer } from "../src/schema.js";
import {
  ActionRateLimitError,
  ActionSerializationError,
  createActionRateLimiter,
  assertSerializableActionValue,
  type RateLimitKeyResolver,
  type ActionRateLimitOptions,
  type InferInput,
  type InferOutput,
  type SerializableActionValue,
  type SerializationPolicyResult,
  type SerializationPolicyViolation,
  validateSerializableActionValue,
} from "../src/server.js";
import type { Config } from "../src/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

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

const nestedConfig = defineConfig({
  compiler: {
    generatedDir: "src/.aruna",
    manifest: "src/.aruna/manifest.json",
  },
  actions: {
    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },
  },
  conventions: {
    client: ["src/client.ts"],
    server: ["src/server.ts"],
    shared: ["src/shared/**"],
  },
});

const nestedConfigShape: Config = nestedConfig;
void nestedConfigShape;

const serializableValue: SerializableActionValue = {
  itemId: "sword",
  metadata: {
    tags: ["rare"],
    enabled: true,
    optional: undefined,
  },
};

const serializationResult: SerializationPolicyResult =
  validateSerializableActionValue(serializableValue);

if (!serializationResult.ok) {
  const firstViolation = serializationResult.violations[0];
  void firstViolation;
}

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

    void ctx;
    void input;

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
    void ctx;
    return null;
  },
});

// The Roblox-flavored `defineAction` from `aruna/roblox` defaults `TPlayer` to
// `Player`, so `ctx.player` is `Player` with no annotation.
const robloxAction = defineRobloxAction({
  id: "shop.robloxPlayer",
  input: schema.object({ amount: schema.number() }),
  run(ctx, input) {
    type _RobloxCtxPlayer = Expect<Equal<typeof ctx.player, Player>>;
    type _RobloxInput = Expect<Equal<typeof input, { amount: number }>>;
    void ctx;
    void input;
    return null;
  },
});
void robloxAction;

const actions = {
  "shop.purchaseItem": purchaseItem,
  "shop.noSchema": noSchemaAction,
};

const clientApp = createClientApp({
  transport: async () => {
    return { ok: true };
  },
});

const serverApp = createServerApp({ actions });
const remoteEventInvoker = createRemoteEventActionInvoker({
  FireServer() {
    return undefined;
  },
  OnClientEvent: {
    Connect() {
      return {
        Disconnect() {
          return undefined;
        },
      };
    },
  },
} satisfies RemoteEventClientLike);

type _PurchaseItemInput = Expect<
  Equal<
    InferInput<typeof purchaseItem>,
    {
      itemId: string;
      quantity: number;
    }
  >
>;

type _PurchaseItemOutput = Expect<
  Equal<
    InferOutput<typeof purchaseItem>,
    {
      ok: boolean;
    }
  >
>;

type _NoSchemaActionInput = Expect<Equal<InferInput<typeof noSchemaAction>, unknown>>;
type _NoSchemaActionOutput = Expect<Equal<InferOutput<typeof noSchemaAction>, unknown>>;
type _RegistryAction = Expect<Equal<(typeof actions)["shop.purchaseItem"], typeof purchaseItem>>;
type _AppActions = Expect<Equal<typeof serverApp.actions, typeof actions>>;
type _ClientDispose = Expect<Equal<typeof clientApp.dispose, () => void>>;
type _ClientOptionsNoAny = Expect<Equal<IsAny<Parameters<typeof createClientApp>[0]>, false>>;
type _ServerOptionsNoAny = Expect<Equal<IsAny<Parameters<typeof createServerApp>[0]>, false>>;
type _ServerDispatch = Expect<Equal<ReturnType<typeof serverApp.dispatch>, Promise<unknown>>>;
type _RateLimitOptionsNoAny = Expect<Equal<IsAny<ActionRateLimitOptions>, false>>;
type _RateLimitKeyResolverNoAny = Expect<Equal<IsAny<RateLimitKeyResolver>, false>>;
type _RateLimitErrorNoAny = Expect<Equal<IsAny<ActionRateLimitError>, false>>;
type _RateLimiterNoAny = Expect<Equal<IsAny<typeof createActionRateLimiter>, false>>;
type _RemoteEventInvoker = Expect<
  Equal<ReturnType<typeof createRemoteEventActionInvoker>, DisposableActionInvoker>
>;
type _DefaultRemoteEventInvoker = Expect<
  Equal<ReturnType<typeof createActionInvoker>, DisposableActionInvoker>
>;
type _RemoteEventOptionsNoAny = Expect<
  Equal<IsAny<Parameters<typeof createRemoteEventActionInvoker>[1]>, false>
>;
type _RemoteEventClientNoAny = Expect<
  Equal<IsAny<Parameters<typeof createRemoteEventActionInvoker>[0]>, false>
>;
type _RemoteEventInvokerDispose = Expect<Equal<typeof remoteEventInvoker.dispose, () => void>>;
type _DefaultRemoteEventInvokerOptionsNoAny = Expect<
  Equal<IsAny<Parameters<typeof createActionInvoker>[0]>, false>
>;
type _DefaultRemoteEventBinding = Expect<
  Equal<ReturnType<typeof bindActions>, ServerBinding>
>;
type _DefaultRemoteEventBindingOptionsNoAny = Expect<
  Equal<IsAny<Parameters<typeof bindActions>[1]>, false>
>;
type _SerializableValueNoAny = Expect<Equal<IsAny<SerializableActionValue>, false>>;
type _SerializationResultNoAny = Expect<Equal<IsAny<SerializationPolicyResult>, false>>;
type _SerializationViolationNoAny = Expect<Equal<IsAny<SerializationPolicyViolation>, false>>;
type _SerializationErrorNoAny = Expect<Equal<IsAny<ActionSerializationError>, false>>;
type _SerializationHelpersNoAny = Expect<
  Equal<IsAny<typeof validateSerializableActionValue>, false>
>;
type _SerializationAssertNoAny = Expect<Equal<IsAny<typeof assertSerializableActionValue>, false>>;

// --- Gap 2: a registry-typed publisher on the action ctx ---------------------
// A `createActionDefiner`-bound `defineAction` makes `ctx.publisher` non-optional
// and checks `to/toMany/toAll` against the real signal ids and payloads.
const signalRegistryForTypes = {
  scoreChanged: defineSignal({
    id: "scoreChanged",
    payload: schema.object({ score: schema.number() }),
  }),
};

const definePublishingAction = createActionDefiner<typeof signalRegistryForTypes, string>();

definePublishingAction({
  id: "score.bump",
  input: schema.object({ amount: schema.number() }),
  run(ctx, input) {
    // No optional chaining required: the publisher is guaranteed present.
    ctx.publisher.toAll("scoreChanged", { score: input.amount });
    ctx.publisher.to("p1", "scoreChanged", { score: input.amount });
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
