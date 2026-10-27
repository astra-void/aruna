# Schema

`aruna/schema` defines the wire contract for action inputs/outputs and signal payloads.
Builders return plain immutable objects — there is **no runtime validation cost to build
them**; validation happens at the boundary when a message crosses the wire. The same
schema drives type inference (`Infer`) and the binary codec.

```ts
import { schema, type Infer } from "aruna/schema";
```

## Primitives

```ts
schema.string()       // string
schema.number()       // number (f64 by default)
schema.boolean()      // boolean
schema.literal("coins") // the literal "coins"
```

## Numeric width hints

Same TypeScript type (`number`), but a narrower wire encoding for the binary codec. Use
them to shrink payloads; values out of range fail validation.

```ts
schema.f32()   // 32-bit float
schema.u8()    // 0..255
schema.u16()   // 0..65535
schema.u32()   // 0..4294967295
schema.i8()    // -128..127
schema.i16()   // -32768..32767
schema.i32()   // -2147483648..2147483647
```

## Constraints

Chained after a builder, a constraint adds a runtime check without changing the type or
the wire format. A value that fails it fails validation like a wrong type does.

```ts
schema.number().min(0).max(100).int()
schema.string().minLength(1).maxLength(64)      // UTF-8 bytes
schema.string().minChars(2).maxChars(16)        // characters (code points)
schema.array(schema.string()).minItems(1).maxItems(8)
schema.number().refine((value) => value % 2 === 0, "expected an even number")
```

**String lengths are bytes.** `minLength`, `maxLength`, and `length` count UTF-8 bytes,
which is what a string costs on the wire and in the binary codec: `"abc"`
is 3, `"가나다"` is 9, `"😀"` is 4. They are the right tool for a size budget (an
unreliable signal, a DataStore record). For a limit a person reads — a name, a chat line —
use `minChars` / `maxChars`, which count code points: `"가나다"` is 3 and `"😀"` is 1.
A string that is not valid UTF-8 has no character count and fails `minChars` /
`maxChars` (natively, where `utf8.len` returns nil; in Node, a string with a lone
surrogate). Both can be chained when a field needs both kinds of limit:

```ts
schema.string().maxChars(40).maxLength(120)  // 40 characters, and never over 120 bytes
```

The compiler reads a literal `.maxLength(n)` / `.maxItems(n)` (and `.maxChars(n)`, as at
most 4n bytes) to size signal payloads, and the [store gate](./stores.md#the-compatibility-gate)
compares them across builds. Every other constraint is runtime code it cannot evaluate;
it records a hash of the chain so the gate can at least tell one changed.

## Collections & composition

```ts
schema.array(schema.string())              // string[]

schema.object({
  itemId: schema.string(),
  quantity: schema.u8(),
  coupon: schema.optional(schema.string()), // coupon?: string | undefined
})

schema.optional(schema.number())            // number | undefined
schema.enum(["red", "green", "blue"])       // "red" | "green" | "blue"
schema.union([schema.string(), schema.number()]) // string | number

schema.record(schema.number())              // Record<string, number> — string keys only
schema.tuple([schema.string(), schema.u8()]) // [string, number] — exact length enforced
```

`record` is a homogeneous string-keyed map: every key must be a string (non-string keys
don't survive the plain-data boundary) and every value must match the value schema.
`tuple` is a fixed-length heterogeneous array validated positionally — a value with a
different length fails. Both cross the binary codec with a deterministic layout
(records encode entries sorted by key; tuples encode a fixed sequence with no length
prefix).

Schemas are immutable. To extend an object schema, spread its `.shape` into a new one —
never mutate:

```ts
const base = schema.object({ x: schema.number() });
const extended = schema.object({ ...base.shape, y: schema.number() });
```

## Roblox userdata

First-class builders for the common Roblox userdata types. They cross the wire as plain
records and are reconstructed as native userdata in the Roblox runtime.

```ts
schema.vector3()  // { x: number; y: number; z: number }
schema.color3()   // { r: number; g: number; b: number }
schema.cframe()   // { components: readonly number[] }  (12 floats)
```

Every numeric component must be finite: a `Vector3` with a NaN component fails
validation and the wire-safety check, like a bare NaN does.

`schema.instance()` is the one way an `Instance` (a `Player` included) crosses the action
boundary. An Instance is a reference into the DataModel, not data, so it is accepted only
where the schema declares `schema.instance()` — an action with no input schema, or an
undeclared field, rejects it as `ActionSerializationError`. It cannot travel on a
`wire: "binary"` signal.

## Inference

`Infer<typeof s>` turns a schema into its TypeScript type. Define a schema once and
derive the type from it rather than declaring both:

```ts
import { schema, type Infer } from "aruna/schema";

const purchaseInput = schema.object({
  itemId: schema.string(),
  quantity: schema.number(),
  currency: schema.literal("coins"),
  coupon: schema.optional(schema.string()),
});

type PurchaseInput = Infer<typeof purchaseInput>;
// { itemId: string; quantity: number; currency: "coins"; coupon?: string | undefined }
```

> `Infer` is the single schema-inference type name.

There are matching helpers for definitions: `InferInput`/`InferOutput` (from
`aruna/server`) on an action, and `InferSignalPayload` on a signal.

## Schema resolution in the compiler

The compiler reads `input`/`output`/`payload` whether the schema is written inline
(`input: schema.object({...})`), extracted to a module-level `const` and referenced
(`input: purchaseInputSchema`), or **imported from another module** — keeping schemas in
a shared `schema.ts` and importing them into the action file is the supported, common
pattern (`import { purchaseInput } from "./schema"`).

The rules, precisely:

- Locally, `const a = b; const b = schema.object({...})` chains resolve (cycles are
  reported).
- Across modules, resolution follows **one import hop**: the imported name must be a
  module-level `const schema.*(...)` expression (or a local const chain to one) in the
  target file. A re-export chain through a second module does not resolve.
- A schema reference that resolves to nothing — a typo, a non-schema import, or a
  two-hop chain — is a **hard error** (`aruna::565`), not a warning: letting it degrade
  would silently produce `unknown`-typed client stubs and an empty contract entry.
- Schemas built by helper functions, generics, or object spread
  (`schema.object({ ...base.shape })`) are not statically analyzable; they still
  validate correctly at runtime, but the compiler records no metadata for them
  (warning `aruna::553`/`554`/`564`) — the generated client types fall back to
  `unknown` and the contract snapshot omits the shape.
