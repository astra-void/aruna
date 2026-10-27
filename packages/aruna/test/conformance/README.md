# Dispatch conformance cases

`dispatch.json` is one table of dispatch cases that both runtimes run:

- Node: `test/conformance.test.ts` (vitest)
- native: `apps/roblox-runtime-test/lune/specs/conformance.luau` (Lune, against the
  compiled roblox-ts runtime)

Each runner turns the table into its own runtime's calls and checks the
payload that would go on the wire. Node goes through `createServerApp` with a
loopback RemoteEvent transport. Native reads the `registry.dispatch` result,
which its binder sends as is. Both skip the response for a `fireAndForget`
action.

## Case

| field        | meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `name`       | the test name in both runners                                              |
| `actions`    | action fixtures, below                                                     |
| `middleware` | optional labels, outermost first; each records `label:before` / `label:after` |
| `exposeInternalErrors` | optional; passed to the app (default off) |
| `steps`      | run in order                                                               |
| `trace`      | everything recorded across the case: `run` for each handler call, the middleware labels, `onError` |

A step is either `{ "advanceMs": n }`, which steps the frozen rate-limit clock,
or a dispatch:

```json
{ "dispatch": "actionId", "input": {}, "expect": { "ok": false, "errorName": "..." } }
```

A dispatch step may add `"idempotencyKey": "..."`, which is sent the way a
retrying client sends it (the request envelope's key in Node, the 4th argument
of `registry.dispatch` natively).

`expect` fields (each one optional):

- `ok`: the response's `ok`
- `output`: deep-equal to the response's output
- `errorName`: equal to the response's error name
- `message`: equal to the response's error message
- `messageContains`: a substring of the response's error message
- `errorId`: `true` when the response must carry an 8-hex-digit `errorId`,
  the same one `onError` received for that call. `false` when it must carry
  none.
- `onErrorName`: the `name` of the error `onError` received for that call
  (the original error, before any masking)
- `noResponse`: `true` when no response is sent at all

## Action fixture

`id`, then `behavior`, which is one of:

| behavior         | the handler                                  | extra fields          |
| ---------------- | -------------------------------------------- | --------------------- |
| `echoInput`      | returns its input                            |                       |
| `returnConstant` | returns `value`                              | `value`               |
| `returnFunction` | returns `{ handler = <function> }`           |                       |
| `throwError`     | throws the runtime's own error: `new Error(message)` / `error(message)` | `message` |
| `throwTable`     | throws a plain `{ name, message }` table     | `errorName`, `message` |
| `throwActionError` | throws `actionError(errorName, message)`   | `errorName`, `message` |

Optional: `input` and `output` schema descriptors, `rateLimit`
(`{ windowMs, max }`), `fireAndForget`.

A schema descriptor is `{ "type": "string" | "number" | "boolean" | "instance" }` or
`{ "type": "object", "fields": { name: descriptor } }`. A number descriptor can
add `"format": "f32"` for `schema.f32()`. A string descriptor can add
`"minLength"`, `"maxLength"` (UTF-8 bytes), `"minChars"`, and `"maxChars"` (code
points), chained in that order. Any of them can add `"default": value`.

JSON has no functions and no non-finite numbers, so two sentinels stand in for
them anywhere in an input value, and each runner swaps them before dispatch:

- `{ "$function": true }` becomes a function
- `{ "$number": "NaN" | "Infinity" | "-Infinity" }` becomes that number (`0/0`,
  `math.huge`, `-math.huge` in Luau)
- `{ "$array": { "length": n, "of": value } }` becomes an array of `n` copies
  of `value` (itself materialized), for inputs too large to write out
- `{ "$instance": "Part" }` becomes an Instance of that class (a real one under
  Lune; in Node, an object with `IsA` and `ClassName`, which is how the Node
  runtime recognizes one)

That is how a case sends input that can't cross the wire.

A case that needs more than this belongs in a runtime's own tests.
