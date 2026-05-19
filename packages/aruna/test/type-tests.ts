import { createClientApp } from "../src/client.js";
import {
  bindDefaultRobloxActionRemoteEvent,
  createRemoteEventActionInvoker,
  createDefaultRobloxActionInvoker,
  type DisposableActionInvoker,
  type RemoteEventClientLike,
} from "../src/roblox-runtime.js";
import { createServerApp } from "../src/server-app.js";
import { defineAction } from "../src/server.js";
import { type ServerBinding } from "../src/runtime/binding.js";
import { schema, type InferSchema } from "../src/schema.js";
import { type InferInput, type InferOutput } from "../src/server-runtime.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

const stringSchema = schema.string();
const numberSchema = schema.number();
const booleanSchema = schema.boolean();
const literalSchema = schema.literal("sword");
const optionalSchema = schema.optional(schema.string());
const arraySchema = schema.array(schema.string());
const enumSchema = schema.enum(["a", "b"] as const);
const objectSchema = schema.object({
  itemId: schema.string(),
  quantity: schema.number(),
  note: schema.optional(schema.string()),
});

type _StringSchema = Expect<Equal<InferSchema<typeof stringSchema>, string>>;
type _NumberSchema = Expect<Equal<InferSchema<typeof numberSchema>, number>>;
type _BooleanSchema = Expect<Equal<InferSchema<typeof booleanSchema>, boolean>>;
type _LiteralSchema = Expect<Equal<InferSchema<typeof literalSchema>, "sword">>;
type _OptionalSchema = Expect<Equal<InferSchema<typeof optionalSchema>, string | undefined>>;
type _ArraySchema = Expect<Equal<InferSchema<typeof arraySchema>, string[]>>;
type _EnumSchema = Expect<Equal<InferSchema<typeof enumSchema>, "a" | "b">>;
type _ObjectSchema = Expect<
  Equal<
    InferSchema<typeof objectSchema>,
    {
      itemId: string;
      quantity: number;
      note?: string | undefined;
    }
  >
>;

const purchaseItem = defineAction({
  id: "shop.purchaseItem",
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
  run(_ctx, input) {
    type _NoSchemaInput = Expect<Equal<typeof input, unknown>>;
    return null;
  },
});

const actions = {
  "shop.purchaseItem": purchaseItem,
  "shop.noSchema": noSchemaAction,
};

const clientApp = createClientApp({
  invoker: async () => {
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
type _RegistryAction = Expect<Equal<typeof actions["shop.purchaseItem"], typeof purchaseItem>>;
type _AppActions = Expect<Equal<typeof serverApp.actions, typeof actions>>;
type _ClientDispose = Expect<Equal<typeof clientApp.dispose, () => void>>;
type _ClientOptionsNoAny = Expect<Equal<IsAny<Parameters<typeof createClientApp>[0]>, false>>;
type _ServerOptionsNoAny = Expect<Equal<IsAny<Parameters<typeof createServerApp>[0]>, false>>;
type _ServerDispatch = Expect<Equal<ReturnType<typeof serverApp.dispatch>, Promise<unknown>>>;
type _RemoteEventInvoker = Expect<Equal<ReturnType<typeof createRemoteEventActionInvoker>, DisposableActionInvoker>>;
type _DefaultRemoteEventInvoker = Expect<
  Equal<ReturnType<typeof createDefaultRobloxActionInvoker>, DisposableActionInvoker>
>;
type _RemoteEventOptionsNoAny = Expect<
  Equal<IsAny<Parameters<typeof createRemoteEventActionInvoker>[1]>, false>
>;
type _RemoteEventClientNoAny = Expect<
  Equal<IsAny<Parameters<typeof createRemoteEventActionInvoker>[0]>, false>
>;
type _RemoteEventInvokerDispose = Expect<Equal<typeof remoteEventInvoker.dispose, () => void>>;
type _DefaultRemoteEventInvokerOptionsNoAny = Expect<
  Equal<IsAny<Parameters<typeof createDefaultRobloxActionInvoker>[0]>, false>
>;
type _DefaultRemoteEventBinding = Expect<
  Equal<ReturnType<typeof bindDefaultRobloxActionRemoteEvent>, ServerBinding>
>;
type _DefaultRemoteEventBindingOptionsNoAny = Expect<
  Equal<IsAny<Parameters<typeof bindDefaultRobloxActionRemoteEvent>[1]>, false>
>;
