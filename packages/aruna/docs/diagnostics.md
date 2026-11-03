# Diagnostics

Every diagnostic Aruna reports, by code. `aruna check`, `aruna build` and `aruna inspect`
print them; `--json` gives each one as `{ code, name, severity, message, file?, span?,
details?, suggestion? }` ([JSON output](./cli.md#json-output)).

- **Severity** is the default. An error fails the command (exit 1). A warning fails it
  only with `--warnings-as-errors`.
- **Changing severity.** The `strict` options named below raise or lower their own
  codes, and `diagnostics.ignore` in `aruna.config.ts` drops any code, by code or by name
  ([Config](./cli.md#config-arunaconfigts)).
- **Codes are stable.** A code keeps its meaning and is never reused, and changing a
  default severity is a breaking change ([stability](../../../docs/stability.md)).
  Retired codes: `aruna::109`, `aruna::110`, `aruna::112`.

## Project and config (1xx)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::100` | `invalid-config` | error | `aruna.config.ts` could not be loaded, or sets a key or value it does not accept. |
| `aruna::102` | `missing-tsconfig` | warning | The project has no `tsconfig.json`. `aruna init` and `aruna build` create one ([tsconfig.json](./cli.md#tsconfigjson)). |
| `aruna::103` | `invalid-tsconfig` | error | `tsconfig.json` could not be parsed. Aruna leaves it alone until it parses. |
| `aruna::105` | `unresolved-import` | warning | A relative import names no file. It is not analyzed further. `strict.unresolvedImports` sets the severity. |
| `aruna::106` | `parse-failed` | error | A source file could not be parsed as TypeScript. |
| `aruna::111` | `tsconfig-alias-desync` | warning | A `tsconfig.json` alias points somewhere the current layout does not emit, usually after an upgrade. Reported by the CLI; run `aruna doctor --fix` ([troubleshooting](./troubleshooting.md#aruna-imports-do-not-resolve)). |

## Module classification (2xx)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::200` | `unknown-module-kind` | warning | A file matches no client, server or shared convention, so no boundary rule applies to it ([Module boundaries](./architecture.md#module-boundaries-client--server--shared)). |
| `aruna::203` | `ambiguous-convention-match` | warning | A file matches more than one convention. Narrow the patterns in `conventions` so it matches one. |

## Boundaries (3xx)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::300` | `client-imports-server` | error | Client code imports a server module ([Module boundaries](./architecture.md#module-boundaries-client--server--shared)). |
| `aruna::301` | `server-imports-client` | error | Server code imports a client module. |
| `aruna::302` | `shared-imports-client` | error | A shared module imports a client module, so it cannot load on the server. |
| `aruna::303` | `shared-imports-server` | error | A shared module imports a server module, so it cannot load on the client. |
| `aruna::304` | `cross-domain-private-import` | warning | An import reaches past another domain's public surface ([Domain boundaries](./architecture.md#domain-boundaries-domain-to-domain)). `strict.domainBoundary` sets the severity. |
| `aruna::305` | `test-module-imported` | error | Game code imports a spec. The game build leaves specs out, so the import would not resolve ([testing](./testing.md)). |
| `aruna::306` | `shared-transitive-server-dependency` | error | A shared module reaches server code through other shared modules ([shared safety](./shared-safety.md#what-a-shared-module-reaches-through-other-modules)). |
| `aruna::307` | `shared-transitive-client-dependency` | error | A shared module reaches client code through other shared modules. |
| `aruna::308` | `shared-server-service-at-load` | error | A shared module reads a server-only service at module scope, which runs on the client as it loads ([shared safety](./shared-safety.md#server-only-services-in-shared-code)). |
| `aruna::309` | `shared-server-service-access` | warning | A shared module reads a server-only service in a function with no `IsServer()` guard. |

`strict.sharedSafety: false` turns off 306–309; 300–305 always apply.

## Actions and signals (5xx)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::507` | `raw-remote-usage` | warning | Code uses a `RemoteEvent` or `RemoteFunction` directly instead of an action or signal. `strict.rawRemoteUsage` sets the severity. |
| `aruna::510` | `unreliable-signal-payload-unbounded` | warning | An unreliable signal's payload has no size bound, so it may exceed Roblox's limit and be dropped ([payload size](./signals.md#payload-size)). |
| `aruna::511` | `unreliable-signal-payload-too-large` | error | An unreliable signal's payload can exceed Roblox's limit. |
| `aruna::512` | `invalid-signal-wire` | error | A signal's `wire` is not a literal `"table"` or `"binary"`, or its payload cannot use the binary encoding ([binary wire](./signals.md#binary-wire)). |
| `aruna::513` | `unreliable-signal-payload-near-limit` | warning | A table-encoded unreliable signal's smallest size is close enough to the limit that its real size may be over it. |
| `aruna::514` | `unbounded-action-input` | warning | An action input has a string, array or record with no upper bound ([Bounding input](./actions.md#bounding-input)). `strict.unboundedInput` sets the severity. |
| `aruna::550` | `invalid-action-definition` | error | `defineAction` is not called with an object literal, or its `id` is not a static string. |
| `aruna::551` | `action-missing-run` | error | An action has no `run`. |
| `aruna::552` | `action-run-not-function` | error | An action's `run` is not a function. |
| `aruna::553` | `action-input-schema-invalid` | warning | The compiler cannot read an action's input schema, so the contract and the generated stub type it as unknown. |
| `aruna::554` | `action-output-schema-invalid` | warning | The same, for the output schema. |
| `aruna::555` | `duplicate-action-id` | error | Two actions use the same `id`. |
| `aruna::556` | `action-imported-from-invalid-environment` | error | Client code imports an action's module. Call the generated stub from `$aruna/actions/client` instead. |
| `aruna::557` | `duplicate-generated-action-export` | error | Two actions would generate the same stub name in `$aruna/actions/client`. Rename one export. |
| `aruna::558` | `generated-action-type-name-collision` | error | Two actions would generate the same type name. |
| `aruna::559` | `invalid-action-fire-and-forget` | error | `fireAndForget` is not a boolean literal. |
| `aruna::560` | `invalid-action-rate-limit` | error | An action's `rateLimit` is not an object of positive integer literals ([Rate limiting](./actions.md#rate-limiting)). A bad `actions.defaultRateLimit` is `aruna::100`. |
| `aruna::563` | `duplicate-signal-id` | error | Two signals use the same `id`. |
| `aruna::564` | `signal-payload-schema-invalid` | warning | The compiler cannot read a signal's payload schema. |
| `aruna::565` | `unresolved-schema-reference` | error | A name used as a schema resolves to nothing, locally or through one import ([schema](./schema.md#schema-resolution-in-the-compiler)). |
| `aruna::566` | `generated-signal-payload-type-collision` | error | Two signals would generate the same payload type name. |
| `aruna::568` | `unknown-hook-export` | warning | With `entries: "generated"`, a hook module exports a name the generated entry never reads ([Generated entries](./architecture.md#generated-entries-entries-generated)). |
| `aruna::569` | `invalid-action-idempotent` | error | `idempotent` is not a boolean literal ([Retries and idempotency](./actions.md#retries-and-idempotency)). |
| `aruna::584` | `invalid-action-errors` | error | An action's `errors` is not an object literal of declarations ([Declared errors](./actions.md#declared-errors)). |
| `aruna::585` | `action-error-data-schema-invalid` | warning | The compiler cannot read a declared error's `data` schema. |
| `aruna::591` | `invalid-action-authorize` | error | `authorize` is not a function ([authorize](./actions.md#authorize)). |
| `aruna::592` | `invalid-signal-definition` | error | `defineSignal` is not called with an object literal, has no static `id`, or its `unreliable` is not a boolean literal. |

## Stores (570–579)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::570` | `invalid-store-definition` | error | `defineStore` / `definePlayerStore` is not called with an object literal, or its `id` is not a static string ([stores](./stores.md#diagnostics)). |
| `aruna::571` | `store-missing-schema` | error | A store has no `schema`. |
| `aruna::572` | `store-schema-invalid` | warning | The compiler cannot read a store's schema. |
| `aruna::573` | `duplicate-store-id` | error | Two stores use the same `id`. |
| `aruna::574` | `store-imported-from-client` | error | Client code imports a store. Stores are server-only; return the data through an action. |
| `aruna::575` | `invalid-store-version` | error | A store's `version` is not a positive integer literal. |
| `aruna::576` | `store-missing-default` | error | A store has no `defaultValue`. |
| `aruna::577` | `store-version-without-migrate` | warning | A store has a `version` above 1 but no `migrate`. |
| `aruna::578` | `store-incompatible-change` | error | A store change would leave records saved by the committed snapshot's build unreadable ([the store compatibility gate](./cli.md#the-store-compatibility-gate)). `strict.storeCompatibility` sets the severity. |
| `aruna::579` | `contract-snapshot-invalid` | error | The committed contract snapshot could not be read, so no store was checked. |

## Runtimes (580–582)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::580` | `invalid-runtime-definition` | error | A `defineRuntime` is not an object literal, has no `start`, or its `id` or an `after` entry is not a static string ([domain runtimes](./architecture.md#domain-runtimes-defineruntime)). |
| `aruna::581` | `duplicate-runtime-id` | error | Two runtimes use the same `id`. |
| `aruna::582` | `unresolved-runtime-order` | error | An `after` names no runtime, names its own runtime, or forms a cycle. |

## Resources (586–590)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::586` | `invalid-resource-definition` | error | `defineResource` is not called with an object literal, or has no static `id`, an invalid `scope`, no `load`, or an `authorize` that is not a function ([resources](./resources.md#diagnostics-and-tooling)). |
| `aruna::587` | `duplicate-resource-id` | error | Two resources use the same `id`. |
| `aruna::588` | `resource-schema-invalid` | warning | The compiler cannot read a resource's schema. |
| `aruna::589` | `resource-missing-schema` | error | A resource has no `schema`. |
| `aruna::590` | `generated-resource-name-collision` | error | Two resources would generate the same binding name in `$aruna/resources/client`. |

## Output and internal (7xx, 9xx)

| Code | Name | Severity | Meaning |
| --- | --- | --- | --- |
| `aruna::700` | `manifest-write-failed` | error | The manifest could not be written: check the path and permissions of `compiler.manifest`. |
| `aruna::701` | `generated-output-write-failed` | error | A generated file could not be written into `generatedDir`. |
| `aruna::900` | `internal-compiler-error` | error | A bug in Aruna. Please report it with the message and, if you can, the file that triggered it. |
