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

> `Infer` is the single schema-inference type name, identical across both runtimes.

There are matching helpers for definitions: `InferInput`/`InferOutput` (from
`aruna/server`) on an action, and `InferSignalPayload` on a signal.

## Schema resolution in the compiler

The compiler reads `input`/`output`/`payload` whether the schema is written inline
(`input: schema.object({...})`) or extracted to a module-level `const` and referenced
(`input: purchaseInputSchema`). Keeping schemas in a shared `schema.ts` and importing them
into the action file is a supported, common pattern.
