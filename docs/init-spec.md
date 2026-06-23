# aruna-framework-spec

# Aruna — RFC / Spec v0.1

## Document Status

Draft

## Implementation Status

Phase 1 is considered complete as a local MVP / release-candidate baseline.

Phase 1 now includes:

- Rust-owned compiler core in `crates/aruna_compiler`
- N-API bridge in `crates/aruna_napi`
- TypeScript product shell for CLI, config loading, formatting, and native loading
- SWC-based TS/TSX static import parsing
- path-based `client` / `server` / `shared` module classification
- import graph construction and boundary diagnostics
- deterministic manifest generation
- fixture-based compiler tests
- `aruna check`
- `aruna inspect modules`
- `aruna inspect graph`
- spec-palette CLI formatting with JSON / no-color safety
- `.npm/` native staging for the current host target
- target-qualified staged native artifacts such as `compiler.darwin-arm64.node`
- no TypeScript analyzer fallback

Phase 1.1 should focus onrelease engineering and hardening rather than new framework features.

Phase 2 should begin the first real framework feature layer: server actions, schema validation, serialization policy, generated stubs, and a minimal runtime transport built on top of the proven compiler foundation.

## Applied Addendum — Config, Contracts, Security, and Tooling

This addendum records additional implementation-facing decisions for Aruna. These sections are intended to make the RFC more actionable for compiler, CLI, LSP, testing, and security work without changing the original high-level direction.

Design rule:

> Aruna should remain convention-first, compile-time-first, and thin at runtime, while exposing enough explicit contracts for users, tools, and tests to understand what the framework is doing.
> 

## Source Topology Direction

Aruna should not force a named feature container such as `features/`, `game/`, `modules/`, or `app/` as the default project layout.

The default source root should be plain `src/`. Aruna should only require the minimum conventions needed to classify runtime boundaries and generate safe Roblox placement:

- explicit environment directives for ordinary modules: `"use client"`, `"use server"`, `"use shared"`
- reserved script-entry markers only where a real Roblox `LocalScript` or `Script` should be generated
- ordinary client-only, server-only, and shared imported modules should remain ModuleScripts unless they are explicit runtime entries
- generated output under `.aruna/`
- generated Rojo placement should distinguish module environment from Roblox instance class
- config overrides for teams that want folder-based conventions

All higher-level organization should remain user-owned. Users may choose `shop/`, `systems/`, `ui/`, `domains/`, `features/`, `app/`, or any other layout under `src/` as long as Aruna can safely classify each module.

Example default direction:

```
src/
  client.tsx        # Aruna maps this entry to a LocalScript through generated Rojo output
  server.ts         # Aruna maps this entry to a Script through generated Rojo output

  shop/
    screen.tsx      # ordinary client module, classified by directive or import graph
    actions.ts      # ordinary server module or action module, classified by directive or action discovery
    model.ts        # shared-safe module
    schema.ts       # shared-safe schema module

  inventory/
    screen.tsx
    actions.ts
    model.ts

  shared/
    ids.ts
    constants.ts

  .aruna/
    actions.generated.ts
    manifest.json
```

## Recommended Layout v0

Aruna should not require a specific folder structure, but official starters, examples, and documentation should provide one strong recommended layout to reduce confusion for new projects.

Recommended default layout:

```
src/
  client.tsx        # explicit client runtime entry, emitted as a LocalScript through generated Rojo output
  server.ts         # explicit server runtime entry, emitted as a Script through generated Rojo output

  app/
    bootstrap.ts    # optional app-level setup and composition
    providers.ts    # optional shared app providers / root wiring

  domains/
    shop/
      actions.ts    # server actions owned by this domain
      schema.ts     # action input/output schemas and serializable contracts
      model.ts      # shared-safe domain model, IDs, constants, DTOs
      ui.tsx        # client UI for this domain

    inventory/
      actions.ts
      schema.ts
      model.ts
      ui.tsx

    combat/
      model.ts
      runtime.ts    # gameplay/runtime logic for this domain

    waves/
      actions.ts
      schema.ts
      model.ts
      runtime.ts

  shared/
    constants.ts    # cross-domain constants
    ids.ts          # globally shared IDs / branded identifiers
    result.ts       # shared result helpers / DTO utilities

  .aruna/
    actions.client.generated.ts
    actions.server.generated.ts
    manifest.json
```

Recommended layout rules:

- `src/client.tsx` and `src/server.ts` are the default runtime entries.
- `domains/` is the recommended home for game features and gameplay domains.
- `shared/` is reserved for cross-domain shared-safe code, not arbitrary server/client logic.
- domain-local shared code should stay inside the domain when it is not globally reusable.
- `.aruna/` is generated output and should be safe to delete/regenerate.
- official starters should use this layout by default.
- users may still override conventions through `aruna.config.ts` when their project needs a different organization.

Naming guidance:

- prefer `domains/` over `features/` for the official Roblox game starter, because it maps naturally to gameplay areas such as `shop`, `inventory`, `combat`, `waves`, `quests`, and `progression`.
- avoid requiring every client-only or server-only module to use `.client.ts` / `.server.ts` suffixes.
- reserve `.client` and `.server` suffixes for real Roblox script instance hints or explicit entry-like files.

Documentation rule:

> The recommended layout is recommended, not required. Aruna should give users a clear default path without taking ownership of their domain taxonomy.
> 

Design rule:

> Aruna should define runtime boundaries, not prescribe the user's domain taxonomy.
> 

Rojo integration rule:

> `.client` and `.server` suffixes should be treated as Roblox script instance hints, not as general-purpose Aruna environment markers. Aruna should avoid requiring users to name every client-only module `.client.ts`, because Rojo/roblox-ts workflows can interpret emitted `.client.lua` files as `LocalScript` instances rather than requireable ModuleScripts.
> 

Confirmed direction:

> Aruna separates module environment from Roblox instance class. A module may be client-only, server-only, or shared-safe while still being emitted as a `ModuleScript`. Only explicit runtime entries should become `LocalScript` or `Script` instances in generated Rojo output.
> 

---

# Appendix A. Configuration Model

## A.1 `aruna.config.ts`

Aruna should expose a typed `defineConfig()` helper from the public `aruna` package.

The config file should be optional for simple projects, but it becomes the shared source of truth for:

- project root detection
- convention overrides
- diagnostic severity overrides
- generated output locations
- action transport policy
- strictness mode
- raw remote policy
- test / inspect behavior
- future plugin registration

Example:

```tsx
// aruna.config.ts
import { defineConfig } from "aruna";

export default defineConfig({
  root: "src",

  conventions: {
    client: ["src/client/**", "src/features/**/client/**"],
    server: ["src/server/**", "src/features/**/server/**"],
    shared: ["src/shared/**", "src/features/**/shared/**"],
  },

  strict: {
    sharedSafety: true,
    rawRemoteUsage: "warning",
    unresolvedImports: "warning",
  },

  compiler: {
    manifest: ".aruna/manifest.json",
    generatedDir: "src/.aruna",
    preserveGeneratedComments: true,
  },

  actions: {
    transport: "remote-event",
    defaultRateLimit: {
      windowMs: 1000,
      max: 20,
    },
  },
});
```

## A.2 Config Design Rules

- config customizes conventions; it should not replace the framework model
- config should be typed and editor-friendly
- config should avoid requiring users to repeat obvious defaults
- invalid config should produce stable diagnostics
- CLI, compiler, LSP, tests, and codegen should all resolve the same config model

Potential diagnostic area:

```
aruna::100 invalid-config
aruna::101 config-load-failed
aruna::102 missing-tsconfig
aruna::103 invalid-convention-pattern
aruna::104 generated-dir-outside-project
```

---

# Appendix B. Generated Output Contract

Aruna relies on code generation, so generated output is part of the developer experience.

Generated files must be:

- deterministic
- stable across identical inputs
- clearly marked as generated
- safe to delete and regenerate
- excluded from manual editing
- suitable for snapshot testing

Generated files should prefer:

- explicit imports
- plain TypeScript
- readable output
- small generated modules over one massive generated file
- stable ordering by normalized path or stable ID

Generated files should avoid:

- nondeterministic ordering
- timestamps in generated content
- machine-specific absolute paths
- hidden runtime registration side effects
- generated names that are hard to trace back to source

Example generated header:

```tsx
// Generated by Aruna. Do not edit by hand.
// Source: aruna manifest v1
```

Design rule:

> Generated output should be inspectable, debuggable, and boring.
> 

---

# Appendix C. Manifest Schema

Aruna should emit a machine-readable manifest that describes module classification, import edges, generated action stubs, diagnostics, and compiler metadata.

The manifest is used by:

- `aruna inspect`
- `aruna graph`
- LSP hover / quick fixes
- CI diagnostics
- snapshot tests
- debugging generated output

Initial shape:

```tsx
type Manifest = {
  version: 1;
  projectRoot: string;

  modules: Array<{
    id: string;
    path: string;
    kind: "client" | "server" | "shared" | "server_action";
    classification: {
      source: "convention" | "directive" | "config";
      reason: string;
      matchedPattern?: string;
    };
    imports: string[];
  }>;

  actions: Array<{
    id: string;
    file: string;
    exportName: string;
    inputSchema?: string;
    outputSchema?: string;
    clientStubPath: string;
  }>;

  diagnostics: Array<{
    code: `aruna::${number}`;
    name: string;
    severity: "error" | "warning" | "info";
    file?: string;
    message: string;
  }>;
};
```

Manifest rules:

- manifest schema version must be explicit
- manifest output must be deterministic
- paths should be normalized and project-relative where possible
- manifest should not include local machine-specific absolute paths unless explicitly requested for debugging
- LSP and CLI should be able to detect manifest version mismatch

Potential diagnostics:

```
aruna::700 manifest-write-failed
aruna::701 manifest-version-unsupported
aruna::702 manifest-read-failed
aruna::703 generated-file-conflict
aruna::704 stale-generated-output
```

---

# Appendix D. Server Action Definition API

Server actions are server-owned authority boundaries exposed to the client through generated stubs.

The canonical definition helper is `defineAction()`.

Example server-side definition:

```tsx
// src/features/shop/server/actions.ts
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",

  input: schema.object({
    itemId: schema.string(),
    quantity: schema.number().int().min(1),
  }),

  output: schema.object({
    ok: schema.boolean(),
    receiptId: schema.string().optional(),
  }),

  async run(ctx, input) {
    const player = ctx.player;

    return {
      ok: true,
      receiptId: "receipt_123",
    };
  },
});
```

Generated client usage:

```tsx
import { purchaseItem } from "@/features/shop/actions.generated";

const result = await purchaseItem({
  itemId: "sword",
  quantity: 1,
});
```

Server action rules:

- action implementation is server-only
- client can only import generated stubs
- action input must be serializable
- action output must be serializable
- `Player` is provided by server context, never by client input
- action IDs must be globally unique
- action handlers should be statically discoverable
- action input should be validated before user code runs
- generated stubs are convenience APIs, not trust boundaries

Potential diagnostics:

```
aruna::550 invalid-action-definition
aruna::551 action-missing-run
aruna::552 action-run-not-function
aruna::553 action-input-schema-invalid
aruna::554 action-output-schema-invalid
aruna::555 duplicate-action-id
aruna::556 action-imported-from-invalid-environment
aruna::557 missing-generated-action-stub
aruna::558 missing-server-action-handler
aruna::559 action-uses-client-only-api
```

---

# Appendix E. Runtime Schema DSL

Aruna should provide a Roblox-friendly schema DSL instead of depending on a large external validation library.

The schema system should be:

- serializable as metadata
- understandable by compiler/codegen where possible
- usable at runtime for validation
- small enough for Roblox runtime constraints
- friendly to TypeScript inference

Example:

```tsx
import { schema } from "aruna/schema";

const PurchaseInput = schema.object({
  itemId: schema.string(),
  quantity: schema.number().int().min(1),
});
```

Phase 1 schema primitives:

- string
- number
- boolean
- literal
- array
- object
- optional
- limited union
- enum

Deferred schema features:

- recursive schemas
- arbitrary transforms
- async validation
- custom validator closures crossing network boundaries
- branded types
- complex refinement chains

Design rule:

> Aruna schemas should be serializable metadata first, runtime validators second.
> 

---

# Appendix F. Serialization Boundary Policy

Roblox-specific value types make serialization rules an important part of Aruna's security and DX model.

Allowed across action boundaries by default:

- string
- number
- boolean
- nil / undefined equivalent
- arrays
- plain objects
- enums / literals

Conditionally allowed if explicitly supported by Aruna serialization:

- Vector2
- Vector3
- CFrame
- Color3
- UDim
- UDim2
- BrickColor

Forbidden across action boundaries by default:

- Instance
- Player
- RBXScriptConnection
- function
- thread
- service objects
- userdata not explicitly supported
- authority-bearing internal server state

Policy:

- Instances should not cross action boundaries by default
- use stable IDs, references, DTOs, or framework-defined handles instead
- server-owned objects should be resolved on the server
- output DTOs should be explicit and client-safe

Potential diagnostics:

```
aruna::600 non-serializable-action-input
aruna::601 non-serializable-action-output
aruna::602 unsafe-instance-cross-boundary
aruna::603 authority-bearing-shared-state
aruna::604 shared-imports-roblox-service
aruna::605 shared-has-environment-side-effect
aruna::606 secret-exposed-to-client
```

---

# Appendix G. Security Model

Aruna assumes:

- the client is untrusted
- all client action input is attacker-controlled
- server actions are authority boundaries
- shared code must not contain authority-bearing secrets
- generated client stubs are convenience APIs, not trust boundaries
- validation and authorization are server responsibilities

Server action security rules:

- never trust client-provided player identity
- never expose server-only modules through generated stubs
- validate all client input
- prefer explicit output DTOs
- avoid returning authority-bearing internal state
- support rate limiting / throttling policy
- make unsafe opt-outs visible and auditable

Design rule:

> Network convenience must not make unsafe remote exposure easier than safe remote exposure.
> 

---

# Appendix H. Rate Limit and Abuse Control

Typed server actions should have a first-class rate limit policy.

Example:

```tsx
export const purchaseItem = defineAction({
  id: "shop.purchaseItem",

  rateLimit: {
    key: "player",
    windowMs: 1000,
    max: 5,
  },

  async run(ctx, input) {
    // ...
  },
});
```

Rate limit policy:

- default per-player action rate limit should be configurable
- actions may override the default rate limit
- some trusted internal actions may opt out explicitly
- opt-out should be visible in generated metadata / inspect output
- rate limit keys should initially support `player` and action ID
- future keys may support IP-like proxies only if the Roblox environment makes that meaningful

Potential diagnostics:

```
aruna::508 remote-rate-limit-missing
aruna::560 invalid-action-rate-limit
aruna::561 unsafe-action-rate-limit-opt-out
```

---

# Framework Feature Layer Direction: Actions, Resources, Policies, and Inspection

`defineAction()` is the foundation, not the whole framework.

Aruna should not position itself as only a typed RemoteFunction / RemoteEvent wrapper. The product-level value should come from combining compiler-discovered server actions, server-owned resources, policy metadata, state invalidation, generated networking, and inspectable authority flow.

Core feature model:

```
Actions    = client-to-server commands
Resources  = server-owned readable state snapshots
Policies   = authorization, cooldown, rate limit, and lifecycle rules
Schemas    = serializable data contracts across network boundaries
Inspector  = CLI/LSP visibility into authority flow and generated wiring
Codegen    = safe stubs, registries, manifests, and Rojo-aware output
```

Design rule:

> Server actions are the syntax. Authority-aware generated gameplay architecture is the product.
> 

## Server Resources / State Sync

Aruna should eventually provide `defineResource()` for server-owned readable state.

Resources should represent server-authoritative snapshots that the client may read or subscribe to without importing server implementation modules.

Example:

```tsx
import { defineResource } from "aruna/server";
import { schema } from "aruna/schema";

export const inventoryResource = defineResource({
  id: "inventory.current",

  scope: "player",

  output: schema.object({
    coins: schema.number(),
    items: schema.array(schema.string()),
    equippedItemId: schema.string().optional(),
  }),

  get(ctx) {
    return getInventorySnapshot(ctx.player);
  },
});
```

Client usage should import generated resource handles, not server implementation modules:

```tsx
import { useResource } from "aruna/client";
import { inventoryResource } from "./.aruna/resources.client.generated";

const inventory = useResource(inventoryResource);
```

Resource rules:

- resource implementation is server-only
- client code may only import generated client resource handles
- resource output must be serializable and validated through schema metadata
- resources may be scoped as `player`, `server`, or future explicit scopes
- player-scoped resources must never leak another player's private state
- resources should be snapshot-first; subscriptions and push updates may be layered later
- resources should be visible in manifest and inspect output

Potential diagnostics:

```
aruna::570 invalid-resource-definition
aruna::571 duplicate-resource-id
aruna::572 resource-output-schema-invalid
aruna::573 resource-imported-from-invalid-environment
aruna::574 non-serializable-resource-output
aruna::575 unsafe-resource-scope
aruna::576 resource-leaks-player-state
```

## Resource Invalidation

Actions should be able to declare which resources they invalidate.

Example:

```tsx
export const purchaseItem = defineAction({
  id: "shop.purchaseItem",

  invalidates: [inventoryResource, shopResource],

  input: schema.object({
    itemId: schema.string(),
  }),

  async run(ctx, input) {
    await buyItem(ctx.player, input.itemId);
    return { ok: true };
  },
});
```

Invalidation rules:

- invalidation metadata should be statically discoverable where possible
- action-to-resource invalidation edges should be recorded in the manifest
- client helpers may refetch invalidated resources after successful action calls
- server runtime may support push invalidation later
- invalidation must not weaken authority boundaries

Potential diagnostics:

```
aruna::577 invalid-resource-invalidation
aruna::578 unknown-invalidated-resource
aruna::579 cross-scope-resource-invalidation-risk
```

## Action Policy

Actions should support explicit policy metadata close to the authority boundary.

Policies should cover cooldowns, rate limits, authorization gates, and domain-specific conditions without forcing a class-based service model.

Example:

```tsx
export const upgradeWeapon = defineAction({
  id: "weapon.upgrade",

  policy: {
    requirePlayer: true,
    cooldownMs: 1000,
    rateLimit: { key: "player", windowMs: 1000, max: 3 },
  },

  input: schema.object({
    weaponId: schema.string(),
  }),

  async run(ctx, input) {
    // ...
  },
});
```

Policy rules:

- policy metadata should be visible in generated manifest and inspect output
- unsafe opt-outs should be explicit and auditable
- policies should be plain functions or metadata, not mandatory decorated classes
- policy failure should have stable error shapes suitable for client UX

Potential diagnostics:

```
aruna::562 invalid-action-policy
aruna::563 unsafe-action-policy-opt-out
aruna::564 action-policy-not-serializable
aruna::565 action-policy-imports-client-module
```

## Authority Graph / Security Inspector

Aruna should expose an authority-oriented inspection mode that explains what the client can call, what server state is exposed as resources, and which policies protect each boundary.

Example command direction:

```
aruna inspect authority
```

Example output direction:

```
Authority Graph

Client can call:
  shop.purchaseItem
    input: { itemId: string }
    policy: player rate limit, cooldown 1000ms
    invalidates:
      - inventory.current
    touches:
      - server economy state
      - inventory store

Client can read:
  inventory.current
    scope: player
    output: { coins, items, equippedItemId }

Warnings:
  waves.startWave has no explicit rate limit
  inventory.current may expose private state if scoped incorrectly
```

Inspector rules:

- authority graph should be derived from manifest/compiler metadata where possible
- output should explain client-callable actions, readable resources, policy coverage, invalidation edges, and risky serialization boundaries
- LSP and CLI should share the same underlying metadata
- inspector output should prefer actionable explanations over raw AST details

Design rule:

> If Aruna generates a network boundary, Aruna should be able to explain that boundary.
> 

## Player Session Direction

Aruna may later provide a first-class player session abstraction for common Roblox game state.

This should not be part of the first MVP cutline, because persistence and DataStore behavior can expand scope quickly. However, it is a strong post-MVP feature candidate.

Example direction:

```tsx
export const playerSession = definePlayerSession({
  id: "player.session",

  state: schema.object({
    coins: schema.number(),
    level: schema.number(),
    inventory: schema.array(schema.string()),
  }),

  async load(player) {
    return loadPlayerData(player);
  },

  async save(player, state) {
    await savePlayerData(player, state);
  },
});
```

Session rules:

- session state is server-authoritative
- client access should go through resources or generated DTOs
- DataStore integration should be explicit, testable, and failure-aware
- session state should not be passed across action boundaries as raw authority-bearing objects
- session lifecycle should integrate with PlayerAdded / PlayerRemoving without forcing class-based services

Potential diagnostics:

```
aruna::580 invalid-player-session-definition
aruna::581 player-session-state-schema-invalid
aruna::582 player-session-leaks-server-state
aruna::583 player-session-missing-save-policy
```

## Action and Resource Test Harness

Aruna should provide a test harness that lets users test server actions and resources without starting a full Roblox place whenever possible.

Example direction:

```tsx
import { createActionTestApp } from "aruna/testing";

it("purchases an item", async () => {
  const app = createActionTestApp();
  const player = app.createPlayer({ userId: 1, name: "Player1" });

  const result = await app.call(purchaseItem, player, {
    itemId: "sword",
  });

  expect(result.ok).toBe(true);
});
```

Test harness rules:

- action tests should run user action code with a fake but typed `ctx`
- resource tests should verify snapshots and invalidation behavior
- tests should not require runtime module scanning
- harness behavior should be deterministic and suitable for CI
- Roblox-only APIs should be mocked explicitly, not silently faked in unsafe ways

Design rule:

> Aruna's compiler-owned boundaries should be testable as ordinary project contracts.
> 

## Feature Priority Direction

Suggested post-MVP priority:

```
MVP:
  defineAction
  schema
  generated client/server stubs
  minimal runtime transport
  basic rate limit
  manifest
  inspect actions

v0.2:
  defineResource
  resource manifest entries
  resource invalidation
  client resource helpers
  inspect authority

v0.3:
  action policies
  test harness
  player session foundation
  doctor improvements

v0.4+:
  DataStore integration
  resource subscriptions / push invalidation
  runtime action monitor
  Studio/dev overlay
  migration tooling
```

Product positioning:

> Aruna is not just typed remotes. Aruna is a compiler-first framework for server-authoritative Roblox games with generated networking, validated data boundaries, server-owned resources, and inspectable authority flow.
> 

## DX / Killer Feature Thesis

Aruna's strongest features should remove recurring Roblox-ts project pain that individual teams normally rebuild by hand.

Killer features should be evaluated by whether they make a project safer, easier to inspect, easier to refactor, or easier to test than a raw roblox-ts + Rojo + RemoteEvent setup.

DX value criteria:

```
A feature is Aruna-worthy when it does at least one of these:
- removes repeated remote wiring boilerplate
- turns runtime remote mistakes into compile-time diagnostics
- makes client/server authority boundaries visible
- makes generated behavior inspectable and deterministic
- makes server-owned state readable without exposing server implementation
- makes action/resource contracts snapshot-testable in CI
- makes migration from raw remotes easier instead of all-or-nothing
- improves Studio/debugging feedback without adding heavy runtime architecture
```

Non-goals:

```
- adding APIs only because other frameworks have similar APIs
- hiding too much behavior behind runtime magic
- forcing class/service/controller architecture
- making Aruna feel like a heavy application container
- solving persistence, UI, networking, and gameplay all at once in MVP
```

Design rule:

> Aruna killer features should feel like missing infrastructure that Roblox-ts projects should have had already, not like framework ceremony for its own sake.
> 

## Additional Killer Feature Candidates

The following candidates extend the existing Actions + Resources + Policies + Inspector direction.

### Network Contract Snapshot / Diff

Aruna should be able to emit stable network contract snapshots for actions, resources, schemas, policies, and serialization boundaries.

Example command direction:

```
aruna contracts snapshot
aruna contracts diff
```

Example output direction:

```
Breaking change detected:

shop.purchaseItem input changed:
  - quantity was optional
  + quantity is now required
```

Rules:

- contract snapshots should be deterministic and CI-friendly
- diffs should detect breaking changes in action input/output and resource output
- snapshots should not include machine-specific paths by default
- teams should be able to review network API changes like public API changes

Priority:

```
High. This is a strong post-MVP feature because Aruna already owns action/resource/schema metadata.
```

### Server Error Contract

Aruna should provide a stable error result shape for validation failures, policy denial, rate limiting, and expected domain failures.

Example direction:

```tsx
return fail("not_enough_coins", {
  required: 100,
  current: 50,
});
```

Client handling direction:

```tsx
const result = await purchaseItem({ itemId: "sword" });

if (!result.ok) {
  switch (result.error.code) {
    case "not_enough_coins":
      // show UI message
      break;
  }
}
```

Rules:

- framework-generated failures should use stable codes
- user-defined domain failures should be typed where possible
- internal errors should not leak server details to the client
- error contracts should appear in manifest / contract snapshot output

Priority:

```
High. This can be included near MVP because it improves DX without requiring large runtime scope.
```

### Raw Remote Migration Assistant

Aruna should help existing projects migrate from direct RemoteEvent / RemoteFunction usage.

Example command direction:

```
aruna migrate remotes
```

Example output direction:

```
Detected raw remote:
  ReplicatedStorage.Remotes.PurchaseItem

Used by:
  src/client/shop/ui.tsx
  src/server/shop/handler.ts

Suggested Aruna action:
  shop.purchaseItem
```

Rules:

- early versions may only detect and suggest, not automatically rewrite
- migration output should identify call sites and likely server handlers
- raw remote usage should connect to strictness mode and diagnostics
- migration should make adoption incremental, not all-or-nothing

Priority:

```
Medium-high. Valuable for adoption, but not required for first MVP.
```

### Capability / Permission Model

Action policy may evolve into explicit capabilities for reusable authority checks.

Example direction:

```tsx
export const adminOnly = defineCapability({
  id: "admin.only",

  check(ctx) {
    return isAdmin(ctx.player);
  },
});

export const banPlayer = defineAction({
  id: "admin.banPlayer",
  requires: [adminOnly],
  input: schema.object({ targetUserId: schema.number() }),
  async run(ctx, input) {
    // ...
  },
});
```

Rules:

- capabilities should be visible in authority inspector output
- high-authority actions should be easy to audit
- reusable permission checks should remain plain functions / metadata, not decorated classes

Priority:

```
Medium. This should extend Action Policy after the policy surface is stable.
```

### Optimistic Action + Reconcile

When resources exist, client helpers may support optimistic UI updates and server reconciliation.

Example direction:

```tsx
const equip = useAction(equipItem, {
  optimistic(resources) {
    resources.inventory.current.update((state) => ({
      ...state,
      equippedItemId: "sword",
    }));
  },

  onReject(resources) {
    resources.inventory.current.refetch();
  },
});
```

Rules:

- optimistic updates must be opt-in
- server remains authoritative
- rejection should reconcile resources back to server truth
- this should not be implemented before basic resources and invalidation exist

Priority:

```
Medium. Strong UX feature, but should wait until Resources are stable.
```

### Domain Manifest / Feature Map

Aruna can use recommended `domains/` layout as a discovery aid without requiring it.

Example command direction:

```
aruna inspect domains
```

Example output direction:

```
domains/shop
  actions:
    - shop.purchaseItem
    - shop.sellItem
  resources:
    - shop.catalog
  policies:
    - shop.canPurchase
```

Rules:

- domain detection should be convention-based and optional
- custom layouts should still work through config
- this feature should explain structure, not enforce taxonomy

Priority:

```
Medium. Useful for docs, starter projects, and larger codebases.
```

### Native-First Platform Strategy

Aruna should be native-first for the core gameplay framework layer.

The framework should not feel like a thin adapter collection over unrelated `@rbxts/*` packages. Core workflows should be first-party, integrated, generated, inspectable, and documented as one coherent Aruna experience.

This is closer to the Next.js model: users can still integrate external libraries, but the main productive path should be native to the framework.

Native-first ownership:

```
Aruna-owned core:
  - server/client boundary classification
  - defineAction
  - defineResource
  - resource invalidation
  - action policies / capabilities
  - Player Session Lite
  - native data storage / persistence lifecycle
  - DataStore-backed session profiles
  - schema and serialization contracts
  - generated networking
  - contract snapshot / diff
  - authority inspector
  - server error contract
  - action/resource/session test harness
  - Studio/runtime debug surface
```

#### Native Data Storage Direction

Data storage should be a first-class Aruna-native workflow, not only an adapter story.

Most Roblox games eventually need player data, inventory, currency, progression, unlocks, cooldowns, and save/load lifecycle handling. If Aruna leaves this entirely to external packages, the framework will feel incomplete and users will still have to assemble the most important gameplay state layer by hand.

Aruna should provide a native persistence path in layers:

```
MVP / early:
  - Player Session Lite
  - in-memory session state
  - typed defaults
  - action/resource integration
  - session test harness support

Post-MVP:
  - DataStore-backed player sessions
  - load/save lifecycle
  - dirty tracking
  - retry / failure policy
  - explicit save policy
  - shutdown save handling
  - session lock / conflict direction

Later:
  - migration/versioning helpers
  - backup / recovery hooks
  - profile inspection in devtools
  - adapters for existing data/profile packages only when useful
```

Native data rules:

- player state should be server-authoritative by default
- client access should go through resources or generated DTOs, not raw session objects
- actions should be able to mutate session state through a typed server context
- resources should be able to expose safe snapshots derived from session state
- persistence failure modes should be explicit and testable
- save/load behavior should be visible through devtools or inspect output
- external data/profile packages may be supported later through optional adapters, but the default Aruna starter should not require them

Design rule:

> Player data is core framework infrastructure. Aruna should own the default save/load/session workflow natively.
> 

Adapter / integration layer:

```
Optional or deferred:
  - existing data/profile packages
  - signal/promise utilities
  - external test runners
  - legacy raw remote migration
  - interoperability with Flamework/Knit-style projects
```

Positioning rules:

- Aruna should provide first-party APIs for the flows that define the framework experience.
- adapters should be optional interoperability paths, not the main product story.
- users should be able to build a small game using only Aruna-native actions, resources, sessions, schemas, policies, and generated transport.
- external packages may still be supported when they are clearly outside Aruna's core authority/contract/state boundary model.
- Aruna should avoid becoming a giant runtime dependency container, but it should own the integrated DX layer that makes the framework feel complete.
- migration from Flamework/Knit/raw roblox-ts projects should remain incremental, but new Aruna projects should have a strong native path.

Design rule:

> Adapters are compatibility. Native APIs are the product.
> 

Product thesis:

> Aruna should compete by making server authority, network contracts, player state, resource exposure, diagnostics, and debugging feel like one integrated compiler-first framework experience.
> 

Potential package strategy:

```
@arunajs/core
  public framework APIs and shared runtime contracts

@arunajs/compiler
  Rust-backed compiler wrapper and codegen bridge

@arunajs/runtime
  action/resource transport, validation, policies, sessions

@arunajs/testing
  action/resource/session test harness

@arunajs/devtools
  runtime monitor and future Studio/dev overlay support

@arunajs/adapters-*
  optional ecosystem integrations only when needed
```

Adoption thesis:

> Existing frameworks can organize code, but Aruna should make the network contract, server authority boundary, player state layer, resource exposure layer, and debugging loop native to the framework.
> 

## Awesome Roblox-TS Ecosystem Review: Native Integration Matrix

The `awesome-roblox-ts` package list shows that Roblox-ts developers repeatedly reach for packages around networking, state replication, data stores, runtime validation, frameworks, testing, debug tooling, UI, ECS, and gameplay systems.

Aruna should not attempt to absorb the entire ecosystem. Instead, Aruna should native-own the categories that define a coherent framework experience and leave specialized gameplay/UI/tooling packages as optional ecosystem choices.

Design rule:

> Aruna should native-own the repeated infrastructure that makes server-authoritative Roblox games safe, inspectable, testable, and fast to build.
> 

### Tier 0 — Aruna Identity Layer

These are non-negotiable framework identity pieces. Without them, Aruna is not Aruna.

```
Tier 0 native:
  - Rust-backed compiler core
  - source discovery
  - module classification
  - server/client/shared boundary diagnostics
  - generated output
  - deterministic manifest
  - Rojo-aware placement
  - CLI inspection
  - strictness modes
```

Rationale:

Roblox-ts already has many libraries, but few can see the whole project graph at compile time. Aruna's first advantage is compiler-owned project understanding.

### Tier 1 — Must Be Aruna Native

These areas should be first-party, integrated, generated, documented, and usable without external packages in a new Aruna project.

```
Tier 1 native:
  Networking / authority:
    - defineAction
    - generated client stubs
    - generated server registry
    - action transport
    - schema validation before user code
    - serialization policy
    - server error contract
    - rate limits
    - action policies
    - capabilities / permissions

  Resources / state exposure:
    - defineResource
    - player-scoped resources
    - server-scoped resources
    - resource snapshots
    - resource invalidation
    - optional subscription / push invalidation later

  Player data:
    - definePlayerSession
    - Player Session Lite
    - typed defaults
    - in-memory session state for early phase
    - DataStore-backed sessions later
    - dirty tracking
    - save/load lifecycle
    - retry and failure policy
    - schema migration / versioning direction

  Contracts, inspection, and IDE:
    - contract snapshot
    - contract diff
    - inspect actions
    - inspect resources
    - inspect sessions
    - inspect authority
    - inspect contracts
    - Aruna LSP
    - editor diagnostics
    - hover explanations
    - go-to-definition for generated stubs back to source actions/resources
    - quick fixes for boundary violations and missing generated output

  Testing and devtools:
    - action/resource/session test harness
    - runtime action monitor
    - resource refresh log
    - session dirty/save status
    - Studio/dev overlay direction
```

Rationale:

The ecosystem already contains many networking, state replication, data store, validation, and testing packages. If Aruna delegates these core flows entirely to adapters, it becomes a loose integration guide rather than a framework. Aruna should own the default productive path.

### IDE / LSP Direction

Aruna should provide a first-party Language Server Protocol implementation as part of the native framework experience.

Because Aruna already owns compiler metadata, manifests, generated outputs, diagnostics, schemas, actions, resources, policies, and sessions, the editor should expose that information directly instead of forcing users to run CLI commands manually.

LSP responsibilities:

```
Diagnostics:
  - client imports server module
  - server imports client-only module
  - shared module imports unsafe service
  - action/resource definition is invalid
  - duplicate action/resource/session ID
  - non-serializable input/output/session/resource contract
  - missing generated file or stale generated output
  - raw remote usage under strict policy

Hover:
  - module classification and reason
  - action input/output contract
  - resource scope and output contract
  - session state schema
  - policy/capability requirements
  - generated stub source mapping

Navigation:
  - generated stub -> source action/resource
  - action invalidates -> resource definition
  - resource derives from -> session definition
  - diagnostic -> offending import or contract node

Code actions:
  - add `"use client"` / `"use server"` / `"use shared"` where appropriate
  - move unsafe shared import behind action/resource boundary suggestion
  - regenerate stale generated output
  - create missing schema skeleton
  - add explicit rate limit / policy placeholder
  - convert raw remote call candidate into defineAction skeleton
```

Design rules:

- LSP should share compiler metadata with CLI and manifest output.
- LSP must not reimplement a separate TypeScript analyzer that diverges from the Rust compiler core.
- editor diagnostics should be stable and match CLI diagnostic codes.
- hover and quick fixes should explain Aruna's boundary model without requiring users to read generated files.
- generated files should be navigable, but user edits should be directed back to source files.

Product rule:

> If Aruna is compiler-first, the LSP is how users feel the compiler while writing code.
> 

Suggested package direction:

```
@arunajs/lsp
  language server package powered by compiler metadata and manifest snapshots

@arunajs/vscode
  VS Code extension wrapper for the Aruna LSP
```

Priority:

```
High. LSP should not block the first action MVP, but it should be treated as Tier 1 native DX and planned immediately after the first compiler/codegen vertical slice is stable.
```

### Tier 2 — Native-Lite Framework Utilities

These should exist only where they directly support Aruna-owned features. They should not become broad replacements for ecosystem utility libraries.

```
Tier 2 native-lite:
  - cleanup scope for framework lifecycle
  - framework event logger
  - action/resource/session debug events
  - dev command surface
  - domain manifest / feature map
  - optimistic action + reconcile
  - session migration helpers
  - generated fixture/snapshot helpers
```

Rationale:

The ecosystem has many cleanup, logging, result, command, and debug packages. Aruna should provide the minimum native utilities needed for its own runtime, diagnostics, testing, and devtools to feel integrated.

### Tier 3 — Optional Adapters / Interop

These may be useful for adoption, but they should not define the main product story.

```
Tier 3 optional adapters:
  - existing ProfileService / ProfileStore / DataStore wrappers
  - Flamework interop
  - Knit interop
  - existing raw RemoteEvent / RemoteFunction migration
  - external test runners such as Jest or TestEZ
  - React / Vide / Fusion bindings for resource hooks
  - Charm / Reflex / Replica-style state bridges
  - ECS integration with Matter / Jecs / Planck-style stacks
```

Rationale:

Adapters are compatibility. Native APIs are the product. Existing projects should be able to migrate incrementally, but new Aruna projects should not require a pile of external packages to cover core framework workflows.

### Tier 4 — Do Not Own

These areas should remain ecosystem territory unless there is a narrow integration point.

```
Tier 4 ecosystem-owned:
  - UI component libraries
  - UI renderers such as React, Vide, Fusion, Roact, Plasma
  - ECS engines
  - combat frameworks
  - projectile / raycast / pathfinding libraries
  - behavior tree / GOAP / AI libraries
  - animation / tween libraries
  - math, color, string, array, and data structure utilities
  - external service SDKs such as analytics, Firebase, Firestore, PlayFab, Discord webhooks
  - plugin-specific UI/component tooling
  - specialized camera, character, ragdoll, zone, and VFX systems
```

Rationale:

Owning these would explode scope and make Aruna feel like a monolith. Aruna should integrate cleanly with game-specific libraries, not replace them.

### Native Integration Priority

The ecosystem review reinforces the following priority order:

```
1. Actions + generated networking
2. Schema + serialization + server error contract
3. Player Session Lite
4. Resources + resource invalidation
5. Native data storage lifecycle
6. Action policy + capability
7. Contract snapshot / diff
8. Authority inspector
9. Aruna LSP / editor diagnostics
10. Action/resource/session test harness
11. Runtime monitor / Studio dev overlay
```

Product conclusion:

> Aruna should not be another package in the networking list. Aruna should be the framework layer that turns networking, server state, player data, validation, policy, contracts, testing, and debugging into one native compiler-first Roblox-ts workflow.
> 

---

# Appendix I. Bootstrap and Lifecycle

Aruna should avoid class-first lifecycle systems and runtime module scanning.

Preferred bootstrap direction:

```tsx
// src/server/main.ts
import { createServerApp } from "aruna/server";
import { actions } from "./.aruna/actions.generated";

createServerApp({
  actions,
  plugins: [],
}).start();
```

Client direction:

```tsx
// src/client/main.tsx
import { createClientApp } from "aruna/client";

createClientApp({
  root: "PlayerGui",
}).start();
```

Bootstrap rules:

- one explicit server entry is preferred
- one explicit client entry is preferred
- generated registries may be imported by the entry
- runtime should not scan arbitrary descendants to discover modules
- startup order must be deterministic
- lifecycle hooks should be plain functions, not mandatory decorated classes

---

# Appendix J. Plugin API Policy

Aruna may eventually expose a plugin API, but the initial plugin surface should be conservative.

Possible future shape:

```tsx
import { definePlugin } from "aruna";

export default definePlugin({
  name: "aruna-plugin-example",

  setup(ctx) {
    ctx.diagnostics.register(/* ... */);
    ctx.codegen.register(/* ... */);
  },
});
```

Plugin policy:

- Phase 1 plugin API should be internal or experimental
- plugins must not silently weaken security rules
- plugins that modify boundary behavior must declare that capability explicitly
- plugins should be visible in manifest metadata
- plugin diagnostics should use their own namespace or a reserved Aruna plugin range

Design rule:

> Extension points should not become hidden escape hatches around Aruna's safety model.
> 

---

# Appendix K. CLI Command Surface

Aruna's CLI should make compiler behavior inspectable.

Initial commands:

```
aruna init
aruna dev
aruna build
aruna check
aruna inspect
aruna graph
aruna doctor
aruna clean
```

Command responsibilities:

| Command | Responsibility |
| --- | --- |
| `aruna init` | scaffold config and project structure |
| `aruna dev` | watch source, regenerate output, report diagnostics |
| `aruna build` | generate production-ready output before roblox-ts build |
| `aruna check` | run classification, boundary analysis, and diagnostics |
| `aruna inspect` | explain how a file/action/module was classified |
| `aruna graph` | print module graph / boundary graph |
| `aruna doctor` | validate project setup, tsconfig, roblox-ts, generated dirs |
| `aruna clean` | remove generated outputs |

Example inspect output:

```
Module: src/features/shop/client/panel.tsx
Kind: client
Classified by: convention
Matched pattern: src/features/**/client/**

Imports:
  ✅ src/features/shop/shared/types.ts
  ❌ src/features/shop/server/pricing.ts

Suggestion:
  Move pricing calculation into shared/ if pure,
  or expose it through a server action.
```

---

# Appendix L. Strictness Modes and Raw Remote Policy

Aruna should support incremental adoption through strictness modes.

Suggested modes:

| Mode | Behavior |
| --- | --- |
| `loose` | report only dangerous boundary violations |
| `recommended` | default framework policy |
| `strict` | enforce shared safety, schemas, raw remote warnings, and generated output hygiene |
| `locked-down` | error on unsafe raw remotes except allowlisted files |

Raw remote policy:

- raw remotes are allowed by default for compatibility
- strict mode may warn on raw remote usage inside Aruna-managed modules
- locked-down mode may error on raw remote usage unless allowlisted
- migration should be possible without rewriting an entire project at once

Example:

```tsx
export default defineConfig({
  mode: "strict",

  rawRemotes: {
    policy: "warn",
    allow: ["src/legacy/remotes/**"],
  },
});
```

---

# Appendix M. Compiler Test Fixture Model

Compiler-heavy behavior should be covered by fixture tests.

Each fixture should include:

- input file tree
- optional `aruna.config.ts`
- expected diagnostics
- expected manifest
- expected generated files

Example structure:

```
fixtures/
  client-imports-server/
    input/
      src/client/main.ts
      src/server/secret.ts
    expected/
      diagnostics.json
      manifest.json
```

Fixture rules:

- fixtures should be small and focused
- expected outputs should be deterministic
- diagnostics should be snapshot-friendly
- generated code should not include timestamps or machine-specific paths
- fixture names should map to diagnostic names where possible

---

# Appendix N. MVP Cutline

Phase 1 must include:

- path-based client/server/shared classification
- import boundary diagnostics
- `aruna check`
- manifest emission
- basic generated output hygiene
- fixture-based compiler tests
- config loading with conservative defaults

Phase 1 should include if time allows:

- `aruna inspect`
- minimal action definition parsing
- basic generated action stubs
- minimal runtime schema DSL
- strictness mode plumbing

Phase 1 should not include:

- server components
- public plugin API
- custom Luau emitter
- complex schema transforms
- production-grade action transport
- full visual dev server
- deep Roblox Studio integration beyond final compatibility checks

Design rule:

> The MVP should prove that Aruna can classify modules, enforce boundaries, emit useful diagnostics, and generate inspectable metadata before expanding into larger framework features.
> 

---

# Appendix O. Phase 1 Rust-Only Compiler Core Policy

Phase 1 must use Rust as the real compiler core implementation.

TypeScript may be used for:

- CLI command parsing
- config loading and normalization
- terminal output formatting
- package integration
- JavaScript/native bridge loading
- public facade APIs

TypeScript must not implement or retain a fallback compiler analyzer for Phase 1.

The following responsibilities must be owned by `crates/aruna_compiler`:

- source file discovery
- module classification
- static import extraction
- import resolution
- import graph construction
- client/server/shared boundary validation
- diagnostic generation
- manifest generation
- deterministic compiler output

`packages/compiler` should be a thin wrapper around the Rust compiler core. It may load the native binding, normalize input, and return JSON-compatible output, but it must not duplicate analyzer logic.

If the native compiler cannot be loaded, Aruna should fail clearly and actionably instead of silently falling back to a TypeScript analyzer.

Required failure behavior:

```
Aruna native compiler could not be loaded.
Run the native build, verify platform support, or reinstall the package.
```

Allowed:

- TypeScript type definitions
- TypeScript CLI formatting
- TypeScript wrapper code
- TypeScript test harness calling the Rust-backed API

Forbidden:

- TypeScript file discovery analyzer
- TypeScript module classifier fallback
- TypeScript import graph fallback
- TypeScript boundary validator fallback
- TypeScript manifest generator fallback
- silently continuing when the Rust native compiler is unavailable

Design rule:

> Rust is the source of truth for Phase 1 compiler behavior. TypeScript is the product shell and ecosystem bridge, not a backup compiler.
> 

---

# Appendix P. Native Compiler Packaging Policy

Aruna should prepare native compiler packaging early instead of treating cross-platform support as a late release concern.

The native compiler must not pretend to support a platform by renaming a binary built for another target.

A `.node` file built for `darwin-arm64` is only valid for `darwin-arm64`. It must never be copied or renamed as if it were a Linux, Windows, x64, musl, or other target artifact.

## P.1 Package Split Direction

The long-term package structure should use a JavaScript wrapper package plus real per-platform native packages.

Recommended package layout:

```
@arunajs/compiler
  JavaScript wrapper, native loader, public compiler API

@arunajs/compiler-darwin-arm64
  native binary actually built for macOS arm64

@arunajs/compiler-darwin-x64
  native binary actually built for macOS x64

@arunajs/compiler-win32-x64-msvc
  native binary actually built for Windows x64 MSVC

@arunajs/compiler-win32-arm64-msvc
  native binary actually built for Windows arm64 MSVC

@arunajs/compiler-linux-x64-gnu
  native binary actually built for Linux x64 GNU/glibc

@arunajs/compiler-linux-arm64-gnu
  native binary actually built for Linux arm64 GNU/glibc

@arunajs/compiler-linux-x64-musl
  native binary actually built for Linux x64 musl

@arunajs/compiler-linux-arm64-musl
  native binary actually built for Linux arm64 musl
```

The main `@arunajs/compiler` package should resolve the current platform package at runtime and load the `.node` file from that package.

## P.2 Artifact Truthfulness Rule

Every published native package must contain a binary actually built for that package's target.

Forbidden:

- building once on macOS and renaming the artifact for Linux or Windows
- publishing platform packages from a single host build unless cross-compilation is actually configured and verified
- silently falling back to a TypeScript analyzer if the native package is missing
- making the loader claim support for platforms that are not built in CI

Allowed:

- local development builds for the current host
- CI matrix builds per OS/arch/target
- verified cross-compilation when explicitly configured
- platform packages that contain only their real target artifact

Design rule:

> Native artifact names must describe what was actually built, not what the release process wishes had been built.
> 

## P.3 Main Loader Contract

`@arunajs/compiler` should:

- detect `process.platform`, `process.arch`, and libc/toolchain where needed
- map the current host to a supported platform package
- attempt to require/import that platform package
- load its bundled `aruna_napi.node`
- fail clearly if no matching native package is installed
- never run a TypeScript analyzer fallback

Example failure direction:

```
Aruna native compiler could not be loaded for darwin/arm64.
Expected package: @arunajs/compiler-darwin-arm64

Install dependencies again, verify that this platform is supported, or build the native compiler for local development.
```

## P.4 Phase 1 Preparation Scope

Phase 1 does not need full production publishing automation, but it should prepare the shape early.

Phase 1 should include:

- platform package naming policy
- native package resolver shape
- clear local development fallback to the workspace-built native artifact
- no TypeScript analyzer fallback
- README notes explaining that published platform packages must be real target builds

Phase 1 may defer:

- full CI release matrix
- npm publish automation for every platform
- musl support if not yet verified
- optional dependency packaging details until release workflow work begins

## P.5 CI Matrix Direction

Release CI should eventually build each native package on a correct runner or verified cross-compilation target.

Example direction:

```
macos-latest arm64/x64      -> darwin packages
windows-latest x64/arm64    -> win32-msvc packages
ubuntu-latest x64/arm64     -> linux-gnu packages
linux musl target           -> linux-musl packages, only when verified
```

Each job should upload one verified artifact for one package target. The publish step should never synthesize missing platform artifacts by renaming another target's binary.

Design rule:

> Cross-platform support is a build matrix and package resolution problem, not a filename trick.
> 

## P.6 Native Artifact Filename Policy

Staged native artifacts should use explicit target-qualified filenames instead of a generic `aruna_napi.node` name.

Preferred staged artifact name:

```
compiler.<target>.node
```

Examples:

```
compiler.darwin-arm64.node
compiler.darwin-x64.node
compiler.win32-x64-msvc.node
compiler.linux-x64-gnu.node
compiler.linux-arm64-gnu.node
compiler.linux-x64-musl.node
```

Alternative acceptable form:

```
aruna_compiler.<target>.node
```

The shorter `compiler.<target>.node` form is preferred for package ergonomics because the package name already carries the Aruna namespace.

The raw Cargo/N-API output may still be produced as `aruna_napi.node` or platform-specific dynamic library names during compilation. However, staged npm artifacts should use the target-qualified name so build logs, artifacts, and package contents are self-describing.

Design rule:

> Raw build output names may follow toolchain conventions, but staged npm artifacts should be explicit, target-qualified, and easy to audit.
> 

## P.7 Script Language Policy

Native packaging and release automation should prefer TypeScript executed through `tsx` rather than ad-hoc `.mjs` scripts.

Preferred script shape:

```
scripts/native-targets.ts
scripts/build-native-target.ts
scripts/stage-native-package.ts
scripts/stage-compiler-package.ts
scripts/pack-native-packages.ts
```

The repository may use `tsx` to execute these scripts:

```json
{
  "scripts": {
    "build:native": "tsx scripts/build-native-target.ts"
  }
}
```

Why:

- native packaging has enough branching logic that type safety is useful
- target names, package names, artifact names, and CI metadata should be modeled as explicit TypeScript types
- TypeScript keeps release automation aligned with the rest of the JavaScript-side tooling
- `.mjs` is acceptable for tiny bootstraps, but should not become the long-term packaging automation style

Design rule:

> Packaging automation should be typed and auditable. Prefer `tsx` + TypeScript scripts over growing `.mjs` release scripts.
> 

## P.8 Zig / cargo-zigbuild Selection Policy

Release automation should choose between `cargo` and `cargo zigbuild` based on the requested target and the current environment.

The build tool must not be hardcoded globally.

Recommended policy:

- host-native builds should use plain `cargo build` by default
- Linux GNU/musl cross-target builds may use `cargo zigbuild` when available
- non-host targets must only be staged if their target binary was actually built
- if a target requires Zig/cargo-zigbuild and the tool is unavailable, the release command should fail with a clear install hint unless the command explicitly allows skipping unavailable targets
- local mode should remain fast and host-focused
- cross mode should build only explicitly requested targets
- full mode should require every release target and fail if any required target cannot be built

Example behavior:

```
pnpm release:prepare --mode local
  -> current host target
  -> cargo build

pnpm release:prepare --mode cross --targets linux-x64-gnu
  -> x86_64-unknown-linux-gnu
  -> cargo zigbuild --target x86_64-unknown-linux-gnu

pnpm release:prepare --mode cross --targets linux-x64-gnu --allow-missing-tools
  -> if cargo-zigbuild is missing, skip with a clear warning and do not stage a fake package
```

The release system should expose an explicit policy knob such as:

```
--zig auto | always | never
```

Suggested meanings:

- `auto`: use `cargo zigbuild` only for targets that require or benefit from it, when available
- `always`: require `cargo zigbuild` for cross targets and fail if unavailable
- `never`: do not use `cargo zigbuild`; fail for targets that cannot be built with plain cargo on the current host

Design rule:

> Zig is a real cross-build tool, not a packaging label. Use it automatically when it is the correct build path, but never stage missing or fake target artifacts.
> 

---

# Appendix Q. Phase 1 Exit Status

Phase 1 is complete as a local MVP / release-candidate baseline.

This status means Aruna has proven the MVP cutline:

- classify modules by convention
- parse TS/TSX imports with SWC
- build an import graph
- enforce client/server/shared boundary rules
- emit stable diagnostics
- generate deterministic manifests
- expose compiler behavior through CLI commands
- verify compiler behavior through fixtures
- run the compiler through the Rust native path only

## Q.1 Confirmed Implementation State

The current implementation confirms:

- `crates/aruna_compiler` owns source discovery, SWC parsing, module classification, import graph building, diagnostics, and manifest generation
- `crates/aruna_napi` exposes the Rust compiler to Node
- `packages/compiler` is a native loader / wrapper and does not contain a TypeScript analyzer fallback
- native load failure is hard and actionable
- `.npm/` native staging exists for generated publish package preparation
- static platform packages are not kept under `packages/`
- staged native artifacts use the `compiler.<target>.node` naming policy
- `pnpm build:native` stages only the current host target
- fake platform artifacts are forbidden and not generated
- `.npm/` is generated output and should not be committed
- CLI output respects JSON / no-color / CI behavior
- CLI colors and gradients are sourced from the Aruna spec palette

## Q.2 Confirmed Commands

The Phase 1 exit check has passed:

```
pnpm build:native
pnpm build
pnpm typecheck
pnpm test
cargo test
```

The following smoke commands have also been verified:

```
pnpm aruna check --project fixtures/valid-client-imports-shared/input
pnpm aruna check --project fixtures/invalid-client-imports-server/input
pnpm aruna inspect modules --project fixtures/feature-local-layout/input
pnpm aruna inspect graph --project fixtures/invalid-client-imports-server/input
```

Expected failing smoke commands may exit with code `1` when diagnostics such as `aruna::300` are correctly emitted.

## Q.3 Current Native Staging State

Current host target example:

```
darwin-arm64
```

Staged native artifact example:

```
.npm/compiler-darwin-arm64/compiler.darwin-arm64.node
```

Generated native package example:

```json
{
  "name": "@arunajs/compiler-darwin-arm64",
  "version": "0.1.0",
  "main": "./compiler.darwin-arm64.node",
  "files": ["compiler.darwin-arm64.node"]
}
```

Loader search order:

```
1. installed native package: @arunajs/compiler-<target>/compiler.<target>.node
2. staged local package: .npm/compiler-<target>/compiler.<target>.node
3. workspace cargo output: target/debug/aruna_napi.node
4. workspace cargo output: target/release/aruna_napi.node
```

## Q.4 Remaining Phase 1 Limitations

The following are accepted limitations, not Phase 1 blockers:

- native builds are host-only by default
- explicit non-host targets are rejected until cross-compilation is implemented
- Zig / `cargo-zigbuild` cross-compilation is documented but not implemented
- `.npm/compiler` is staging preparation, not a full publish workflow
- `aruna::700 manifest-write-failed` and `aruna::900 internal-compiler-error` exist, but dedicated end-to-end failure fixtures can be added in Phase 1.1

## Q.5 Recommended Phase 1.1 Work

Phase 1.1 should focus on release engineering and hardening:

- add dedicated fixtures or harnesses for `aruna::700` and `aruna::900`
- add CI checks that verify `.npm/` remains ignored and only the host target is staged
- add guarded cross-target builds using Zig / `cargo-zigbuild` when ready
- add `.npm/compiler` publish staging only when release workflow work is in scope
- prepare npm publish scripts that never use `workspace:*` in publishable manifests
- keep TypeScript analyzer fallback forbidden
- add a JavaScript / TypeScript tooling policy for the repository
- use `oxlint` as the fast code-hygiene linter for TypeScript package code
- keep `tsc --noEmit` as the source of truth for TypeScript type checking
- keep `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings` as the Rust quality gate
- treat `aruna check` as Aruna's domain linter for framework-specific boundary, security, and generation diagnostics
- do not make ESLint, Biome, or Oxlint responsible for Aruna's framework-specific rules
- keep formatter choice separate from linter choice
- prefer stable formatting for committed code; `oxfmt` may be evaluated experimentally, but should not become the default formatter until it is stable enough for repository-wide diffs
- replace the current SWC parser usage with OXC early in Phase 1.1, because the compiler surface is still small enough that a direct migration is cheaper than maintaining two parser backends
- keep Aruna's internal parsed representation normalized so the rest of the compiler does not depend on OXC AST shapes directly
- validate the OXC migration with focused fixtures for static imports, TSX parsing, export-from syntax, type-only imports, ignored dynamic imports, file directives, and byte/span mapping
- remove SWC dependencies and dead code after the OXC parser path passes the existing compiler fixtures
- keep OXC AST types behind Aruna-owned parser records and avoid exposing parser backend types through public compiler output
- remove parser-backend-specific diagnostic wording such as `SWC parser error` once the parser backend becomes swappable

Design rule:

> Phase 1 is complete once the Rust compiler path, diagnostics, manifest, CLI, fixtures, native staging, and tooling boundaries are proven. Phase 1.1 should harden release engineering and parser/tooling infrastructure before Phase 2 introduces new framework features.
> 

---

# Appendix R. Phase 2 — Server Actions and Framework Runtime Foundation

Phase 2 should be the first phase where Aruna becomes more than a compiler boundary checker.

The goal is to introduce a small but real full-stack framework loop:

- define server-owned actions
- validate client input
- generate client-safe stubs
- register server handlers deterministically
- dispatch through a thin Roblox runtime transport
- report unsafe patterns through diagnostics
- keep runtime overhead low

Phase 2 must build on the Phase 1 compiler foundation rather than replacing it with a runtime-first model.

Design rule:

> Phase 2 should prove Aruna's full-stack model with one narrow vertical slice before expanding into services, plugins, dev servers, or advanced editor automation.
> 

## R.1 Phase 2 Theme

Phase 2 theme:

```
Typed server actions over raw remotes.
```

Phase 2 is not about copying Knit Services or Flamework decorators.

It should demonstrate a different model:

- module-first instead of class-first
- explicit server authority instead of implicit remote exposure
- generated client stubs instead of hand-written remote wrappers
- serializable schemas instead of arbitrary payloads
- diagnostics-first safety instead of relying only on runtime failures

Aruna should make the safe path feel like the default path.

## R.2 Phase 2 Scope

Phase 2 should include:

- `defineAction()` definition API MVP
- runtime schema DSL MVP
- serializable input / output validation
- server action discovery from server-owned modules
- deterministic action manifest entries
- generated client stubs
- generated server action registry
- minimal runtime dispatcher over Roblox remotes
- per-player default rate limiting
- action-focused diagnostics
- fixture tests for action discovery, codegen, and invalid boundaries
- smoke tests for generated output shape
- `aruna inspect actions`
- `aruna inspect action <id>`

Phase 2 may include if time allows:

- `aruna dev` watch mode for regeneration
- basic LSP hover for generated action stubs
- quick-fix hints for invalid imports
- richer CLI table output for actions
- minimal integration example project

Phase 2 should not include:

- public plugin API
- custom Luau emitter
- service/controller abstraction layer
- dependency injection container
- server components
- production-grade visual dev server
- full Roblox Studio plugin integration
- complex schema transforms
- arbitrary custom validator closures crossing the network boundary
- deep type-aware analysis before the TypeScript / tsgo situation is mature enough to justify it

## R.3 Server Action API MVP

The initial action API should use `defineAction()` as the canonical declaration helper and stay boring, explicit, and easy for the compiler to discover.

Example:

```tsx
// src/features/shop/server/actions.ts
import { defineAction } from "aruna/server";
import { schema } from "aruna/schema";

export const purchaseItem = defineAction({
  id: "shop.purchaseItem",

  input: schema.object({
    itemId: schema.string(),
    quantity: schema.number().int().min(1),
  }),

  output: schema.object({
    ok: schema.boolean(),
    receiptId: schema.string().optional(),
  }),

  rateLimit: {
    key: "player",
    windowMs: 1000,
    max: 5,
  },

  async run(ctx, input) {
    const player = ctx.player;

    return {
      ok: true,
      receiptId: "receipt_123",
    };
  },
});
```

Generated client usage:

```tsx
import { purchaseItem } from "@/features/shop/actions.generated";

const result = await purchaseItem({
  itemId: "sword",
  quantity: 1,
});
```

Rules:

- action implementation files must be server-owned
- clients must import generated stubs, not server implementation modules
- action IDs must be globally unique
- `ctx.player` is supplied by the server runtime, never by client input
- input validation must run before user code
- output validation should run before returning to the client in strict mode
- generated stubs are DX helpers, not security boundaries

## R.4 Schema DSL MVP

The schema DSL should be small, serializable, and Roblox-friendly.

Initial primitives:

- `schema.string()`
- `schema.number()`
- `schema.boolean()`
- `schema.literal(value)`
- `schema.array(item)`
- `schema.object(shape)`
- `schema.optional(value)`
- `schema.enum(values)`
- limited `schema.union([...])`

Initial number helpers:

- `.int()`
- `.min(value)`
- `.max(value)`

Initial string helpers:

- `.min(length)`
- `.max(length)`
- `.regex(pattern)` only if the runtime cost and Luau translation are acceptable

Deferred:

- recursive schemas
- async validation
- transforms
- arbitrary refinement closures
- branded types
- deep TypeScript checker integration

Design rule:

> Schema metadata must be understandable by codegen and runtime. TypeScript inference is important, but serializable metadata is the source of truth.
> 

## R.5 Serialization Policy MVP

Phase 2 should enforce a conservative serialization policy for action boundaries.

Allowed by default:

- string
- number
- boolean
- nil / undefined equivalent
- arrays
- plain objects
- literals
- enums

Conditionally allowed after explicit implementation:

- Vector2
- Vector3
- CFrame
- Color3
- UDim
- UDim2

Forbidden by default:

- Instance
- Player
- function
- thread
- RBXScriptConnection
- service objects
- userdata not explicitly supported
- server-owned authority objects

Rules:

- `Player` must only come from server context
- Instances should be represented through stable IDs or server-resolved handles
- output DTOs should be explicit and client-safe
- unsupported values should produce diagnostics where statically visible and validation errors where runtime-only

## R.6 Generated Output

Phase 2 generated output should remain deterministic and inspectable.

Generated files may include:

```
src/.aruna/actions.generated.ts
src/.aruna/server-registry.generated.ts
src/.aruna/action-types.generated.ts
.aruna/manifest.json
```

Generated output rules:

- stable ordering by action ID or normalized path
- no timestamps
- no machine-specific absolute paths
- generated headers must be present
- generated stubs should be small and readable
- generated server registry should not scan descendants at runtime
- generated files should be safe to delete and regenerate

Example generated header:

```tsx
// Generated by Aruna. Do not edit by hand.
// Source: aruna action manifest v1
```

## R.7 Manifest v2 Direction

Phase 2 may keep the manifest schema version at `1` if the action fields already fit the existing structure.

If breaking changes are needed, move to manifest version `2` explicitly.

Action manifest entries should include:

```tsx
type ArunaActionManifestEntry = {
  id: string;
  file: string;
  exportName: string;
  environment: "server";
  inputSchema?: string;
  outputSchema?: string;
  clientStubPath: string;
  rateLimit?: {
    key: "player" | "action";
    windowMs: number;
    max: number;
  };
};
```

Manifest rules:

- manifest version must be explicit
- action IDs must be stable
- paths should be project-relative
- generated file paths should be included for inspection
- diagnostics should reference action IDs when possible

## R.8 Runtime Transport MVP

The runtime transport should be intentionally thin.

Initial direction:

- one generated RemoteEvent / RemoteFunction layer may be used internally
- action dispatch should route by action ID
- server registry owns valid handlers
- client stubs should not expose raw RemoteEvent details
- malformed packets should fail safely
- rate limits should run before action execution
- validation should run before action execution
- runtime errors should be converted into safe client-facing failures

The transport should not become a general networking framework yet.

Design rule:

> Phase 2 transport exists to support typed actions, not to expose another low-level remote abstraction.
> 

## R.9 Diagnostics

Phase 2 should add action-focused diagnostics.

Suggested codes:

```
aruna::550 invalid-action-definition
aruna::551 action-missing-run
aruna::552 action-run-not-function
aruna::553 action-input-schema-invalid
aruna::554 action-output-schema-invalid
aruna::555 duplicate-action-id
aruna::556 action-imported-from-invalid-environment
aruna::557 missing-generated-action-stub
aruna::558 missing-server-action-handler
aruna::559 action-uses-client-only-api
aruna::560 invalid-action-rate-limit
aruna::561 unsafe-action-rate-limit-opt-out
aruna::600 non-serializable-action-input
aruna::601 non-serializable-action-output
aruna::602 unsafe-instance-cross-boundary
```

Diagnostic quality requirements:

- message should explain what is unsafe or invalid
- output should identify the file and export when possible
- suggestion should prefer an Aruna-safe pattern
- diagnostics must be stable enough for snapshots
- JSON output must be suitable for CI and editor tooling

## R.10 CLI Additions

Phase 2 CLI additions:

```
aruna inspect actions
aruna inspect action <id>
aruna generate
```

`aruna inspect actions` should show:

```
Action ID            File                                      Rate Limit
shop.purchaseItem    src/features/shop/server/actions.ts       player: 5 / 1000ms
```

`aruna inspect action <id>` should show:

```
Action: shop.purchaseItem
File: src/features/shop/server/actions.ts
Export: purchaseItem
Input schema: yes
Output schema: yes
Rate limit: player, 5 / 1000ms
Client stub: src/.aruna/actions.generated.ts
```

`aruna generate` should regenerate action stubs, server registry, and manifest without running a full roblox-ts build.

## R.11 Test Plan

Phase 2 should use fixture-heavy testing.

Required fixture groups:

- valid server action definition
- duplicate action ID
- client imports server action implementation directly
- client imports generated action stub
- missing input schema in strict mode
- invalid action `run` shape
- non-serializable input schema
- non-serializable output schema
- default rate limit generation
- explicit rate limit override
- unsafe rate limit opt-out in strict mode
- deterministic generated output
- manifest action entry snapshot

Smoke commands should include:

```
pnpm build:native
pnpm build
pnpm typecheck
pnpm test
cargo test
pnpm aruna check --project fixtures/valid-server-action/input
pnpm aruna generate --project fixtures/valid-server-action/input
pnpm aruna inspect actions --project fixtures/valid-server-action/input
```

## R.12 Phase 2 Exit Criteria

Phase 2 is complete when:

- server action definitions are discovered from server-owned modules
- invalid action definitions produce stable diagnostics
- duplicate action IDs are rejected
- client direct imports of server action implementations are rejected
- generated client stubs are emitted deterministically
- generated server registry is emitted deterministically
- manifest includes action metadata
- runtime dispatcher can invoke a registered action through generated client stubs
- input validation runs before handler execution
- default per-player rate limiting exists
- fixture tests cover valid and invalid action flows
- CLI inspection can explain discovered actions
- no TypeScript analyzer fallback is introduced
- no service/controller abstraction is introduced as a hidden dependency

## R.13 Phase 2 Non-Goals

Phase 2 should deliberately avoid expanding too far.

Non-goals:

- replacing roblox-ts
- introducing a custom Luau backend
- building a full dependency injection framework
- copying Knit Services or Flamework decorators
- supporting every Roblox value type across the network
- solving every editor/LSP feature at once
- building a public plugin ecosystem
- making raw remotes impossible
- relying on deep type-aware analysis before the compiler ecosystem is ready

Design rule:

> Phase 2 should make one thing excellent: safe, typed, inspectable server actions. Everything else should wait until that vertical slice is proven.
> 

## R.14 Static Discovery Contract

Phase 2 must define which action patterns are statically discoverable.

Allowed canonical pattern:

```tsx
export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: PurchaseInput,
  output: PurchaseOutput,
  async run(ctx, input) {
    // ...
  },
});
```

Allowed:

- top-level exported `const` initialized by `defineAction({...})`
- `defineAction` imported from `aruna/server`
- action `id` as a string literal
- object-literal action definitions
- schema references declared in the same file or imported from shared modules
- `run` declared as a function or async function property

Not allowed in Phase 2:

- action IDs built dynamically
- actions generated through loops
- actions returned from arbitrary factories
- `defineAction` aliases that hide the original import
- default-exported anonymous action definitions
- client-owned action implementation files
- action implementations under `shared/`
- importing `defineAction` from non-Aruna modules

Potential diagnostics:

```
aruna::562 dynamic-action-id
aruna::563 unsupported-action-factory
aruna::564 action-not-exported
aruna::565 action-defined-outside-server
aruna::566 define-action-import-invalid
aruna::567 unsupported-action-definition-shape
```

Design rule:

> If the compiler cannot explain how an action was discovered, the pattern should not be supported in Phase 2.
> 

## R.15 Client Result and Error Contract

Generated client stubs should use a simple success path and a structured framework error path.

Canonical generated stub shape:

```tsx
export declare function purchaseItem(input: PurchaseItemInput): Promise<PurchaseItemOutput>;
```

Success behavior:

- resolves with the validated action output
- preserves the output type inferred from the schema
- does not expose raw remote packets

Failure behavior:

- rejects with `ArunaActionError`
- does not leak server stack traces to the client by default
- includes a stable error code
- includes the action ID when safe
- may include validation issue paths when safe

Initial error codes:

```
VALIDATION_FAILED
RATE_LIMITED
UNAUTHORIZED
ACTION_NOT_FOUND
TRANSPORT_FAILED
HANDLER_FAILED
OUTPUT_VALIDATION_FAILED
INTERNAL_SERVER_ERROR
```

Example:

```tsx
try {
  const receipt = await purchaseItem({ itemId: "sword", quantity: 1 });
} catch (error) {
  if (isArunaActionError(error) && error.code === "RATE_LIMITED") {
    // show retry UI
  }
}
```

Deferred:

- forcing every action to return a `Result<T, E>` union
- custom typed domain errors across the network
- stack trace forwarding
- cancellation / abort signals

Design rule:

> Client stubs should feel like normal async functions, while framework failures remain structured and inspectable.
> 

## R.16 Authorization and Context Contract

Validation proves that the payload has the right shape. It does not prove that the player is allowed to perform the action.

Phase 2 should reserve an explicit authorization hook.

Example:

```tsx
export const purchaseItem = defineAction({
  id: "shop.purchaseItem",
  input: PurchaseInput,
  output: PurchaseOutput,

  authorize(ctx, input) {
    return ctx.player.UserId > 0;
  },

  async run(ctx, input) {
    // server-owned business logic
  },
});
```

Initial `ctx` shape:

```tsx
type ActionContext = {
  player: Player;
  actionId: string;
  requestId: string;
  now: number;
};
```

Rules:

- `ctx.player` is always server-derived
- authorization runs after input validation and before `run`
- authorization failure should return `UNAUTHORIZED`
- `authorize` must not run on the client
- `ctx` should stay small in Phase 2
- plugin-provided context fields are deferred

Deferred:

- role/permission DSL
- policy composition helpers
- database/session adapters
- custom context injection plugins

Design rule:

> Aruna can make remotes safe by default, but game-specific authorization must stay explicit and server-owned.
> 

## R.17 Runtime Remote Topology MVP

Phase 2 should choose a boring default transport topology.

Recommended MVP topology:

```
ReplicatedStorage
  Aruna
    Actions
      Invoke : RemoteFunction
```

Request packet shape:

```tsx
type ActionRequestPacket = {
  actionId: string;
  requestId: string;
  payload: unknown;
};
```

Response packet shape:

```tsx
type ActionResponsePacket =
  | { ok: true; requestId: string; payload: unknown }
  | { ok: false; requestId: string; error: SerializedActionError };
```

Rules:

- one internal RemoteFunction is acceptable for Phase 2 request/response actions
- client stubs must hide the remote topology
- server registry must reject unknown action IDs
- malformed packets must fail safely
- request IDs should exist for logs and future tracing
- action handlers should not create remotes manually
- per-action remotes are deferred unless a strong need appears

Deferred:

- RemoteEvent-based request/response transport
- streaming actions
- cancellation
- client-to-client messaging
- unreliable remotes
- transport plugins

Design rule:

> The runtime transport should be replaceable later because users code against generated action stubs, not raw Roblox remotes.
> 

## R.18 Generated Client Stub Contract

Generated client stubs are the public client-facing API for actions.

Example generated file:

```tsx
// Generated by Aruna. Do not edit by hand.
// Source: aruna action manifest v1

import { invokeAction } from "aruna/client";
import type { InferSchema } from "aruna/schema";
import { PurchaseInput, PurchaseOutput } from "../features/shop/shared/schemas";

type PurchaseItemInput = InferSchema<typeof PurchaseInput>;
type PurchaseItemOutput = InferSchema<typeof PurchaseOutput>;

export function purchaseItem(input: PurchaseItemInput): Promise<PurchaseItemOutput> {
  return invokeAction("shop.purchaseItem", input);
}
```

Rules:

- generated stub names should follow the exported server action variable name
- action IDs should remain explicit string constants in generated output
- stubs should import only client-safe runtime helpers
- stubs must not import server implementation modules
- stubs should be stable across identical inputs
- generated paths should work with the configured project root and path aliases where possible

Design rule:

> The generated stub is the ergonomic API. The server action file is the authority source. The raw remote is an implementation detail.
> 

## R.19 Phase 2 Config Surface

Phase 2 should add only the config knobs needed to stabilize action behavior.

Suggested config shape:

```tsx
export default defineConfig({
  actions: {
    transport: "remote-function",
    remoteRoot: "ReplicatedStorage/Aruna/Actions",

    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },

    validateOutput: "strict",
    exposeServerErrors: false,
  },
});
```

Rules:

- defaults should be safe and require little setup
- `exposeServerErrors` should default to `false`
- output validation may be configurable for production performance, but strict mode should keep it enabled
- transport options should remain narrow in Phase 2
- invalid config should produce stable diagnostics

Potential diagnostics:

```
aruna::105 invalid-action-transport
aruna::106 invalid-action-remote-root
aruna::107 invalid-output-validation-policy
aruna::108 unsafe-server-error-exposure
```

## R.20 Runtime Observability MVP

Phase 2 should include minimal observability hooks so action failures are debuggable.

Initial server log fields:

```
actionId
requestId
player.UserId
status
errorCode
durationMs
rateLimited
```

Rules:

- logs should not include raw payloads by default
- validation paths may be shown when safe
- server stack traces should stay server-side
- JSON-friendly diagnostic output should remain available through CLI, not runtime logs only
- request IDs should appear in both server logs and client errors when safe

Deferred:

- metrics backend integration
- tracing UI
- Studio plugin panels
- remote log streaming

Design rule:

> When an action fails, the developer should know which action failed, why it failed, and whether the client received a safe error.
> 

## R.21 Suggested Implementation Slices

Phase 2 should be implemented as narrow slices instead of one large rewrite.

Suggested order:

1. schema metadata runtime MVP
2. `defineAction()` public API and TypeScript types
3. Rust compiler action discovery
4. action manifest entries and diagnostics
5. deterministic generated client stubs
6. deterministic generated server registry
7. minimal client/server runtime transport
8. input validation before handler execution
9. rate limiting and authorization hook
10. CLI inspection for actions
11. fixture and smoke coverage

Each slice should leave the repository in a testable state.

Design rule:

> Phase 2 should progress vertically from declaration to discovery to codegen to runtime, not horizontally by designing every future framework abstraction at once.
> 

## Purpose

This document defines the initial design direction for **Aruna**, a next-generation rbxts framework centered around:

- module-first architecture
- compile-time assistance
- low runtime overhead
- strong boundary modeling
- Rust-first implementation for performance-sensitive compiler/tooling paths
- Studio-independent testability wherever possible
- roblox-ts compatibility
- React / JSX friendly DX
- long-term full-stack architecture direction inspired by the *design sensibilities* of Next.js, reinterpreted for Roblox

This document is intended to be a **reference point before implementation**, so later work is guided by explicit decisions instead of vague memory.

## Package Naming

Aruna should be treated as the public product name and user-facing package identity.

Recommended package direction:

- public package / CLI: `aruna`
- official scoped packages: `@arunajs/*`
- default user-facing imports should prefer `aruna` when possible
- package-split or advanced imports may use `@arunajs/*`
- avoid relying on `@aruna/*`, because that npm scope is not available

Initial package layout:

```
aruna                 public facade package and CLI entry
@arunajs/core         public core API and shared framework primitives
@arunajs/compiler     Rust/SWC compiler bridge and transform pipeline
@arunajs/runtime      thin runtime helpers
@arunajs/actions      server action definitions, stubs, and dispatch helpers
@arunajs/lsp          editor tooling / LSP integration
@arunajs/test         Studio-independent testing utilities
@arunajs/create       project scaffolding entrypoint
```

Design rule:

> Documentation should present `aruna` as the primary way users interact with the framework. The `@arunajs/*` packages exist to keep the monorepo modular without fragmenting the public brand.
> 

---

# Part 0. Identity

This part defines Aruna's product identity, package naming, background, vision, goals, and explicit non-goals.

# 1. Background

## 1.1 Problem Statement

Existing Roblox + rbxts framework approaches are powerful, but they often come with tradeoffs that feel increasingly undesirable for this project direction.

Main pain points:

- OOP / class / decorator-heavy structures feel restrictive.
- Runtime-driven registration, scanning, lifecycle dispatch, and resolution layers can introduce overhead and indirection.
- Server / client / shared boundaries are often under-enforced or too dependent on team discipline.
- Repetitive boilerplate exists around remotes, bootstrap wiring, action registration, and boundary-safe access.
- Many architecture and security rules are documented socially rather than enforced structurally.
- Strong compile-time tooling opportunities are often left unused.

## 1.2 Core Design Direction

This framework aims to provide:

- **module-first design instead of class-first design**
- **compile-time transformation instead of runtime magic wherever possible**
- **thin runtime layers**
- **convention-first architecture with explicit override mechanisms**
- **strong diagnostics and editor support**
- **security-aware boundaries as part of architecture, not just discipline**

---

# 2. Vision

> Build Aruna as a compile-time-first rbxts framework that structures client/server/shared boundaries, reduces runtime overhead, improves DX, and remains compatible with the roblox-ts ecosystem.
> 

More concretely:

- Developers write mostly plain TS/TSX modules.
- The Aruna compiler analyzes structure, boundaries, and conventions.
- Generated TS/TSX is passed into roblox-ts.
- roblox-ts remains the TS/TSX -> Luau backend.
- Over time, this can grow into a more cohesive Roblox application platform.

---

# 3. Goals

## 3.1 Short-Term Goals

- Define a client/server/shared boundary model.
- Define module classification rules.
- Provide compile-time diagnostics for invalid cross-boundary imports.
- Build a TS/TSX -> TS/TSX transformation pipeline.
- Preserve compatibility with roblox-ts.
- Keep the runtime extremely thin.

## 3.2 Mid-Term Goals

- Introduce typed server actions.
- Generate bootstrap and registration code.
- Generate client stubs for server actions.
- Add editor-facing tooling via TS Plugin / LSP.
- Improve traceability of generated output.

## 3.3 Long-Term Goals

- Reinterpret a Roblox-native “server component” concept.
- Introduce security-aware view-model / serialization boundaries.
- Support a more cohesive full-stack feature architecture.
- Grow toward a modern rbxts app platform.

---

# 4. Non-Goals

The following are intentionally **not** initial goals:

- Building a custom Luau emitter
- Replacing roblox-ts entirely
- Recreating React Server Components exactly as-is
- Building a huge everything-included framework from day one
- Solving every architectural concern through magic inference
- Forcing all users into a single rigid structure immediately

---

# Part 1. Design Philosophy

This part defines the principles that should guide Aruna's design decisions across compiler, runtime, testing, and developer experience work.

# 5. Core Principles

## 5.1 Module-First

The primary unit is a **module**, not a class.

Developers should be able to express most logic as:

- functions
- plain objects
- exported constants
- typed definitions
- generated boundaries

## 5.2 Compile-Time Over Runtime

If something can be done safely and predictably at compile time, prefer compile time.

Examples:

- module classification
- boundary analysis
- bootstrap generation
- action wiring
- registration manifests

## 5.3 Convention First

The default system should be derived from structure and conventions.

Examples:

- `client/`
- `server/`
- `shared/`
- feature-local subtrees

Directives and explicit overrides should exist, but not be the default for every file.

## 5.4 Predictability Over Magic

A less magical but more understandable system is preferred over a “smart” system that feels untrustworthy.

## 5.5 Thin Runtime

The runtime should remain as small and boring as possible.

Avoid:

- runtime scanning
- reflection-like metadata discovery
- hidden global registration systems
- complex runtime containers as a default requirement

## 5.6 Diagnostics Are a Product Feature

A compile-time-heavy system is only usable if it explains itself well.

Diagnostics must be:

- specific
- actionable
- traceable
- understandable

## 5.7 Incremental Adoption

The framework should support **partial adoption**.

It should be possible to adopt:

- boundary analysis only
- actions only
- generated bootstrap only

without requiring an entire project rewrite.

## 5.8 Rust Where Performance Matters

Performance-sensitive parts of the framework should not hesitate to use Rust early.

This framework is expected to perform source analysis, module classification, import graph traversal, diagnostics, code generation, and potentially editor-facing semantic indexing. These areas can become bottlenecks as project size grows.

Therefore:

- Rust should be preferred for compiler-core logic.
- Rust should be preferred for hot-path analysis and graph processing.
- TypeScript may still be used for CLI glue, configuration loading, editor integration, and ecosystem-facing APIs.
- The framework should avoid delaying Rust adoption until after performance problems become painful.
- The goal is not to rewrite everything in Rust, but to place Rust where it materially improves speed, reliability, and scalability.

Design rule:

> If a part of the system is expected to run frequently, analyze many files, or sit on the editor/build hot path, Rust should be considered the default implementation language unless there is a strong reason otherwise.
> 

## 5.9 Studio-Independent Testability

The framework should make as much logic as possible testable without launching Roblox Studio.

Roblox Studio should be treated as the final integration/runtime environment, not the only place where correctness can be verified.

The framework should encourage code that can be tested through normal CLI-based test workflows whenever possible.

Examples of Studio-independent test targets:

- pure domain logic
- shared schemas and validators
- server action business logic
- input/output serialization rules
- module classification
- import boundary diagnostics
- generated manifest/codegen output
- framework compiler behavior
- runtime dispatch logic with mocked adapters

Design rule:

> Logic that does not truly require Roblox engine state should not require Roblox Studio to test.
> 

---

# Part 2. Architecture Model

This part defines Aruna's compiler pipeline, module model, classification rules, import boundaries, and shared safety expectations.

# 6. Compiler Architecture

## 6.1 Pipeline Overview

```
Source TS / TSX
  -> Aruna Compiler (SWC / Rust)
     - module classification
     - boundary analysis
     - diagnostics
     - optional code generation
     - convention / directive interpretation
  -> Transformed TS / TSX
  -> roblox-ts
  -> Luau
```

## 6.2 Layer Responsibilities

| Layer | Responsibility |
| --- | --- |
| Aruna Compiler | analyze source, classify modules, enforce boundaries, generate code, emit diagnostics |
| roblox-ts | convert TS/TSX into Luau |
| Thin Runtime | execute only the minimum runtime helpers that cannot reasonably be moved to compile time |

## 6.3 Relationship to `vela-rbxts`

Architecturally, this framework compiler lives in the same **general layer** as `vela-rbxts`:

- input: TS/TSX
- transformation: TS/TSX -> TS/TSX
- backend: roblox-ts

Difference:

- `vela-rbxts` is primarily a **styling-oriented precompile transform**.
- Aruna is an **architecture / boundary / codegen-oriented precompile transform** and application framework layer.

## 6.4 Implementation Language Direction

The compiler core should be Rust-first for performance-sensitive responsibilities such as parsing integration, module graph analysis, boundary checking, diagnostics generation, metadata emission, and future semantic indexing.

TypeScript should remain useful at the edges of the system, especially for CLI commands, configuration ergonomics, package integration, and developer-facing APIs.

## 6.5 Expected Compiler Effects

Aruna's compiler should provide value beyond ordinary runtime libraries.

The expected effects are:

- lower runtime overhead by moving classification, wiring, registration, and validation metadata decisions out of runtime paths where possible
- faster feedback for architecture mistakes by detecting boundary violations before Roblox Studio or live runtime testing
- more predictable startup behavior by replacing runtime scanning and implicit discovery with generated registries and manifests
- better security posture by making client/server/shared boundaries, remote contracts, and server authority rules visible to compiler analysis
- better editor and CI integration through stable diagnostics, manifest metadata, and inspectable module graphs
- improved testability by making compiler behavior, module classification, import graphs, generated output, and action/remote contracts testable without Roblox Studio
- clearer debugging because generated metadata can explain why Aruna classified a file, allowed an import, rejected an import, or emitted a diagnostic

Performance expectations should be stated carefully.

Aruna should aim to reduce runtime work and improve build/editor feedback speed, especially as projects grow. However, public documentation should avoid claiming specific speedups until real benchmarks exist.

Expected performance wins:

| Area | Expected Effect | Reason |
| --- | --- | --- |
| runtime startup | less runtime discovery work | registries and manifests can be generated ahead of time |
| remote/action wiring | less handwritten boilerplate and fewer runtime lookup patterns | compiler-generated stubs and server registration can replace repetitive manual setup |
| boundary enforcement | earlier failure | invalid imports can fail in CLI/CI before runtime |
| large-project analysis | better scalability target | Rust compiler-core can handle hot-path graph analysis and diagnostics efficiently |
| editor tooling | faster semantic feedback target | manifest and graph metadata can be reused by future LSP/editor integrations |
| testing | less dependence on Studio for framework correctness | classification, diagnostics, manifests, and generated output can be fixture-tested in CLI |

Non-goals for performance messaging:

- do not claim arbitrary `10x` or benchmark-style speedups without measurement
- do not imply Aruna makes Roblox engine work itself faster
- do not hide the cost of compiler analysis; the goal is to move useful work to predictable build/editor phases
- do not treat Rust as a brand claim by itself; Rust should be justified by hot-path analysis, reliability, and scalability needs

Design rule:

> Aruna should make projects feel faster and safer by moving architectural work out of runtime and into predictable compiler/tooling phases, while being honest about what has and has not been benchmarked.
> 

---

# 7. Module Kinds

## 7.1 Module Kinds Table

| Module Kind | Description | Runs In | Can Import | Cannot Import |
| --- | --- | --- | --- | --- |
| `client` | client-only runtime logic | client | `client`, `shared`, generated client stubs | raw `server` modules |
| `server` | server-only authoritative logic | server | `server`, `shared` | `client` modules |
| `shared` | safe cross-environment logic | both | `shared` | `client`, `server` |
| `server_action` | callable server boundary exposed via generated client stub | server + generated client access | `server`, `shared` internally | direct raw implementation import from `client` |
| `server_component` *(future)* | server-defined safe UI view-model boundary | server + generated client-safe output | TBD | TBD |

## 7.2 Initial Scope

Initial implementation should focus on:

- `client`
- `server`
- `shared`
- minimal `server_action`

`server_component` is a future concept and should not block early implementation.

---

# 8. Module Classification Rules

## 8.1 Default Rule: Path-Based Convention

Initial classification should be derived from path conventions.

### Example structure

```
src/
  client/
  server/
  shared/
```

### Feature-oriented structure

```
src/
  features/
    inventory/
      client/
      server/
      shared/
```

## 8.2 Classification Table

| Path Pattern | Classified As |
| --- | --- |
| `**/client/**` | `client` |
| `**/server/**` | `server` |
| `**/shared/**` | `shared` |

## 8.3 Notes

- Convention should be the default mechanism.
- Most files should not need manual annotation.
- This keeps ceremony low and readability high.

---

# 9. Convention vs Directive Policy

## 9.1 Current Direction

Directives are powerful, but forcing them on every file would create too much ceremony.

Therefore:

- **Convention is primary**
- **Directives are overrides**
- **UI boundary files are the best candidates for directives**

## 9.2 Example directives

```tsx
"use client";
"use server";
```

## 9.3 Directive Policy Table

| Situation | Recommended Approach |
| --- | --- |
| ordinary project structure | convention only |
| obvious `client/server/shared` files | convention only |
| exception to folder classification | directive override |
| UI interactivity boundary | directive may be useful |
| every file annotated manually | avoid |

## 9.4 Design Rule

A directive should feel like an **intentional boundary declaration**, not routine boilerplate.

---

# 10. Import Boundary Rules

## 10.1 Import Rule Matrix

| Importer  Imported | `client` | `server` | `shared` | generated client stub |
| --- | --- | --- | --- | --- |
| `client` | ✅ | ❌ | ✅ | ✅ |
| `server` | ❌ | ✅ | ✅ | N/A |
| `shared` | ❌ | ❌ | ✅ | ❌ |

## 10.2 Rule Summary

### `client`

Allowed:

- other `client` modules
- `shared` modules
- generated client-facing wrappers/stubs

Forbidden:

- raw `server` modules
- server implementation details
- privileged server helpers

### `server`

Allowed:

- other `server` modules
- `shared` modules

Forbidden:

- `client` modules
- client-only APIs hidden inside imported modules

### `shared`

Allowed:

- `shared` modules only

Forbidden:

- `client` modules
- `server` modules
- environment-dependent side effects

---

# 11. Shared Safety Rules

## 11.1 Shared Module Intent

A shared module must remain safe and environment-agnostic.

Good shared content:

- pure utility functions
- schemas
- shared types
- serializable constants
- normalization helpers

Bad shared content:

- server-only privileged access
- client-only UI runtime access
- hidden environment branching with side effects
- secret-bearing or authority-bearing runtime data

## 11.2 Shared Rule Table

| Pattern | Shared Allowed? |
| --- | --- |
| pure utility logic | ✅ |
| schema / validation definitions | ✅ |
| constants / enums / serializable config | ✅ |
| direct player GUI manipulation | ❌ |
| datastore access | ❌ |
| secure purchase validation | ❌ |
| hidden environment-dependent side effects | ❌ |

---

# Part 3. Developer Experience

This part defines how Aruna explains itself to users through diagnostics, editor tooling, generated output traceability, and inspectable behavior.

# 12. Diagnostics Philosophy

## 12.1 Requirements

Diagnostics should answer four questions:

1. where is the problem?
2. what rule was violated?
3. why is it a problem?
4. how can it be fixed?

## 12.2 Good Diagnostic Example

```
src/features/shop/client/panel.tsx is classified as `client`.
It imports src/features/shop/server/pricing.ts, which is classified as `server`.
Move shared logic into `shared/`, or expose this operation through a server action.
```

## 12.3 Bad Diagnostic Example

```
Invalid boundary.
```

## 12.4 Diagnostic Severity Guidance

| Case | Severity |
| --- | --- |
| direct invalid cross-boundary import | error |
| suspicious shared impurity | warning or error depending on strictness |
| unsupported directive placement | error |
| future unsupported feature use | error with suggestion |

## 12.5 Diagnostic Code System

Aruna diagnostics should use stable, searchable diagnostic codes that remain readable in CLI output, editor diagnostics, test snapshots, and documentation.

Diagnostic codes should use a lowercase namespace-style format:

```
aruna::100
```

Rules:

- codes should remain stable once released publicly
- codes should not be reused for unrelated diagnostics
- codes should use lowercase `aruna::` instead of loud uppercase prefixes
- numeric ranges should be grouped by diagnostic area, similar to HTTP status code families
- every diagnostic should include a code, short name, severity, message, explanation, and suggested fix
- documentation should make each diagnostic searchable by code and by short name

Example rendered message:

```
error aruna::300 client-imports-server

src/features/shop/client/panel.tsx is classified as `client`.
It imports src/features/shop/server/pricing.ts, which is classified as `server`.

Move shared logic into `shared/`, or expose this operation through a server action.
```

## 12.6 Diagnostic Code Ranges

| Range | Area | Purpose |
| --- | --- | --- |
| `aruna::100`-`aruna::199` | project / config / resolver | Project setup, config loading, tsconfig handling, path aliases, package exports, and import resolution. |
| `aruna::200`-`aruna::299` | module classification | Determining whether a file is `client`, `server`, `shared`, or a future module kind. |
| `aruna::300`-`aruna::399` | import boundary | Invalid imports across client/server/shared boundaries. |
| `aruna::400`-`aruna::499` | directives / conventions | `"use client"`, `"use server"`, convention overrides, directive placement, and unsupported directives. |
| `aruna::500`-`aruna::599` | network boundary / remotes / actions | Typed remotes, generated remote stubs, server handlers, action IDs, and action import safety. |
| `aruna::600`-`aruna::699` | serialization / shared safety | Serializable action inputs/outputs, unsafe shared state, authority leakage, and client-safe data contracts. |
| `aruna::700`-`aruna::799` | code generation / manifest | Generated files, metadata manifests, stale output, output conflicts, and deterministic codegen issues. |
| `aruna::800`-`aruna::899` | editor / metadata / LSP | Editor integration, semantic indexes, hover metadata, quick fixes, and compiler/editor metadata mismatches. |
| `aruna::900`-`aruna::999` | internal compiler errors | Unexpected parser, resolver, transform, codegen, or unreachable internal states. |

## 12.7 Candidate Phase 1 Diagnostics

Phase 1 should keep the diagnostic surface small and focused on the compiler MVP.

Minimal Phase 1 set:

| Code | Name | Default Severity | Meaning | Suggested Fix |
| --- | --- | --- | --- | --- |
| `aruna::105` | `unresolved-import` | warning | An import could not be resolved during boundary analysis. | Check path aliases, tsconfig settings, package exports, and generated module configuration. |
| `aruna::200` | `unknown-module-kind` | warning | A source file could not be confidently classified as `client`, `server`, or `shared`. | Move the file under a recognized convention path or add an explicit directive if supported. |
| `aruna::300` | `client-imports-server` | error | A `client` module imports a raw `server` module. | Move shared logic into `shared/`, or expose server behavior through an action. |
| `aruna::301` | `server-imports-client` | error | A `server` module imports a `client` module. | Move reusable logic into `shared/`, or keep client-only UI/runtime code on the client side. |
| `aruna::302` | `shared-imports-client` | error | A `shared` module imports a `client` module. | Keep shared modules environment-agnostic and move client-only behavior out of `shared/`. |
| `aruna::303` | `shared-imports-server` | error | A `shared` module imports a `server` module. | Keep authority-bearing logic on the server and expose safe data/contracts through `shared/`. |
| `aruna::900` | `internal-compiler-error` | error | Aruna hit an unexpected internal compiler state. | Treat this as likely an Aruna bug. Preserve the source file and compiler output for reproduction. |

Expanded Phase 1 candidates if needed:

| Code | Name | Default Severity | Area |
| --- | --- | --- | --- |
| `aruna::100` | `invalid-config` | error | project / config |
| `aruna::102` | `missing-tsconfig` | error | project / config |
| `aruna::201` | `conflicting-module-classification` | error | module classification |
| `aruna::203` | `ambiguous-convention-match` | warning | module classification |
| `aruna::400` | `invalid-directive-position` | error | directives / conventions |
| `aruna::401` | `unsupported-directive` | error | directives / conventions |
| `aruna::700` | `manifest-write-failed` | error | code generation / manifest |
| `aruna::703` | `generated-file-conflict` | error | code generation / manifest |

## 12.8 Reserved Future Diagnostics

Future phases can extend the same range system without forcing Phase 1 to implement them immediately.

Network boundary diagnostics:

```
aruna::500 invalid-remote-definition
aruna::501 duplicate-remote-id
aruna::502 remote-input-schema-missing
aruna::503 remote-output-schema-invalid
aruna::504 remote-handler-missing
aruna::505 client-imports-remote-handler
aruna::506 remote-input-uses-player
aruna::507 raw-remote-event-used
aruna::508 remote-rate-limit-missing
aruna::509 unsafe-remote-output

aruna::550 invalid-action-definition
aruna::551 action-missing-run
aruna::552 action-run-not-function
aruna::553 action-input-schema-invalid
aruna::554 action-output-schema-invalid
aruna::555 duplicate-action-id
aruna::556 action-imported-from-invalid-environment
aruna::557 missing-generated-action-stub
aruna::558 missing-server-action-handler
aruna::559 action-uses-client-only-api
```

Serialization and shared safety diagnostics:

```
aruna::600 non-serializable-action-input
aruna::601 non-serializable-action-output
aruna::602 unsafe-instance-cross-boundary
aruna::603 authority-bearing-shared-state
aruna::604 shared-imports-roblox-service
aruna::605 shared-has-environment-side-effect
aruna::606 secret-exposed-to-client
```

Editor and metadata diagnostics:

```
aruna::800 metadata-version-mismatch
aruna::801 semantic-index-stale
aruna::802 lsp-project-not-found
aruna::803 hover-source-unavailable
aruna::804 quick-fix-unavailable
aruna::805 compiler-metadata-missing
```

Internal compiler diagnostics:

```
aruna::900 internal-compiler-error
aruna::901 parser-crash
aruna::902 transform-crash
aruna::903 resolver-crash
aruna::904 codegen-crash
aruna::905 unreachable-state
```

## 12.9 Diagnostic Message Shape

Each diagnostic should be emitted with enough structure for CLI output, editor integrations, test snapshots, and documentation links.

Example shape:

```tsx
type Diagnostic = {
  code: `aruna::${number}`;
  name: string;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  span?: {
    start: number;
    end: number;
  };
  details?: string;
  suggestion?: string;
  docsUrl?: string;
};
```

Docs URL convention:

```
https://arunajs.dev/diagnostics/300
https://arunajs.dev/diagnostics/client-imports-server
```

---

# 13. Runtime Design Principles

## 13.1 Runtime Goals

The runtime should be intentionally small.

The framework’s strength should come from:

- compile-time structure
- generated code
- predictable boundaries

not from a huge runtime layer.

## 13.2 Prefer

- direct imports
- direct calls
- generated registries
- compile-time ordering
- plain objects / plain functions

## 13.3 Avoid

- runtime scanning
- reflection-heavy systems
- hidden registries with implicit discovery
- mandatory heavyweight DI container flows
- lifecycle indirection unless strongly justified

## 13.4 Runtime Rule Table

| Runtime Pattern | Preferred? | Notes |
| --- | --- | --- |
| generated registry import | ✅ | predictable and cheap |
| direct dispatch table | ✅ | good fit |
| runtime tree scanning for modules | ❌ | avoid |
| implicit reflection metadata lookup | ❌ | avoid |
| large default DI container | ❌ | avoid by default |

## 13.5 Testable Runtime Boundaries

Runtime helpers should be designed around small, replaceable adapters.

Instead of hard-coding Roblox services deeply inside business logic, framework runtime APIs should isolate Roblox-specific access behind thin boundaries.

This allows most framework behavior and application logic to be tested in Node.js or another CLI test environment, while keeping Roblox Studio integration tests focused on engine-specific behavior.

---

# Part 4. Feature Model

This part defines the first major framework features built on top of the architecture model: typed remotes, server actions, code generation, and future server-side UI data boundaries.

# 14. Action Model

## 14.1 Purpose

Actions provide a typed boundary for invoking server-authoritative logic from client code.

This should reduce:

- remote boilerplate
- ad hoc wiring
- unsafe cross-boundary patterns

## 14.2 Example Definition

```tsx
// src/features/shop/server/purchase-action.ts
import { defineAction } from "aruna";
import { PurchaseItemInput, PurchaseItemResult } from "../shared/purchase-schema";

export const purchaseItem = defineAction({
  input: PurchaseItemInput,
  output: PurchaseItemResult,
  async run(ctx, input) {
    const player = ctx.player;

    // secure server-side logic
    // validate ownership, balance, inventory state, etc.

    return {
      success: true,
      itemId: input.itemId,
    };
  },
});
```

## 14.3 Example Client Usage

```tsx
// src/features/shop/client/shop-button.tsx
import React from "@rbxts/react";
import { purchaseItem } from "../server/purchase-action";

export function ShopButton() {
  return (
    <textbutton
      Text="Buy"
      Event={{
        Activated: async () => {
          const result = await purchaseItem({ itemId: "sword" });
          print(result.success);
        },
      }}
    />
  );
}
```

## 14.4 Important Note

The client **must not** import the raw server implementation directly at runtime.

What actually happens is conceptually more like:

- the compiler recognizes this as an action boundary
- a client-safe stub is generated
- the raw implementation remains server-side

So the code above is an ergonomic source-level view, not necessarily a literal runtime import behavior.

## 14.5 Action Responsibilities Table

| Responsibility | Handled By |
| --- | --- |
| authoritative logic | server implementation |
| client callable surface | generated client stub |
| input/output boundary typing | action definition + shared schemas |
| remote wiring | code generation |
| runtime dispatch | thin runtime / generated registration |

## 14.6 Action Testability

Server actions should be testable without Roblox Studio when their logic does not depend directly on engine-only behavior.

The action runtime should allow tests to provide a mocked action context.

Example:

```tsx
await purchaseItem.run(
  createTestActionContext({
    player: fakePlayer,
    services: fakeServices,
  }),
  { itemId: "sword" },
);
```

This keeps authoritative server logic easy to test while still allowing Roblox-specific integration tests when needed.

## 14.7 Typed Remote Boundary Layer

Aruna should eventually provide a typed remote layer below the action model.

This is not just a DX feature. It is a security feature.

Raw Roblox remotes are easy to create and call, but without structure they can become a weak boundary between untrusted clients and authoritative server code. Aruna should use compiler analysis and generated code to make remote boundaries explicit, typed, validated, auditable, and harder to misuse.

Core idea:

- developers declare remote contracts in source code
- the compiler analyzes those contracts
- generated bootstrap creates or locates the corresponding Roblox remote instances
- generated client stubs expose the safe client API
- generated server registration connects handlers through validation and context injection
- raw remote usage can be discouraged or diagnosed when it bypasses Aruna's safety model

Example structure:

```
src/
  remotes/
    shop.ts
    inventory.ts
```

Example remote contract:

```tsx
// src/remotes/shop.ts
import { defineRemoteRequest } from "aruna";
import { PurchaseInput, PurchaseResult } from "../shared/shop-schema";

export const purchaseItem = defineRemoteRequest({
  input: PurchaseInput,
  output: PurchaseResult,
  security: {
    requireAuthenticatedPlayer: true,
    rejectUnknownFields: true,
  },
  rateLimit: {
    perPlayer: "10/10s",
    burst: 3,
  },
});
```

Example server handler:

```tsx
// src/server/shop-handlers.ts
import { purchaseItem } from "../remotes/shop";

purchaseItem.handle(async (ctx, input) => {
  const player = ctx.player;

  return purchase(player, input.itemId);
});
```

Example client usage:

```tsx
import { remotes } from "aruna/generated/client";

const result = await remotes.shop.purchaseItem({
  itemId: "sword",
});
```

Security rules:

- clients should call generated stubs, not raw `RemoteEvent` / `RemoteFunction` instances directly
- server handlers should receive trusted context from Aruna, not from client-provided input
- `Player` should be injected through `ctx.player`, not accepted from remote input payloads
- input and output schemas should be validated at the boundary
- unknown fields should be rejectable by default or by strict mode
- rate limits and cooldowns should be attachable at the contract level
- remote definitions should be recorded in a manifest for auditability and editor tooling

Bad pattern:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: s.object({
    player: s.player(),
    itemId: s.string(),
  }),
});
```

Preferred pattern:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: s.object({
    itemId: s.string(),
  }),
});

purchaseItem.handle(async (ctx, input) => {
  const player = ctx.player;
});
```

Relationship to actions:

- typed remotes are the low-level network contract layer
- actions are higher-level server-authoritative business operations
- actions may be implemented on top of typed remotes internally
- this keeps the public action API ergonomic while giving Aruna a reusable, inspectable network boundary foundation

Potential generated Roblox tree:

```
ReplicatedStorage/
  Aruna/
    Remotes/
      shop/
        purchaseItem
      inventory/
        equipItem
```

Early remote types:

| API | Purpose | Notes |
| --- | --- | --- |
| `defineRemoteEvent` | fire-and-forget client/server event | Good for signals that do not need a response. |
| `defineRemoteRequest` | typed request/response boundary | Preferred high-level primitive over exposing raw `RemoteFunction` semantics directly. |
| `defineRemoteFunction` | optional raw RemoteFunction wrapper | May be supported later, but should not be the default abstraction. |

Phase placement:

- Phase 1 should stay focused on import boundaries and diagnostics
- Phase 2 can introduce typed remotes and generated remote registry
- Phase 3 can build actions on top of the typed remote layer
- later phases can add stricter serialization, rate limiting, audit logging, and raw remote usage diagnostics

---

# 15. Code Generation Strategy

## 15.1 Why Code Generation Exists

The following are repetitive and error-prone if done manually:

- bootstrap wiring
- registration manifests
- action client stubs
- action server handlers
- boundary metadata

These are good candidates for generated code.

## 15.2 Early Codegen Targets

| Target | Purpose |
| --- | --- |
| bootstrap entry | initialize known modules in predictable order |
| action registry | keep action registration explicit and generated |
| client stubs | provide ergonomic client-side invocation surface |
| server handlers | connect action definitions to runtime dispatch |
| metadata manifest | optional debug / tooling trace |

## 15.3 Codegen Requirements

Generated code must be:

- deterministic
- inspectable
- debuggable
- traceable back to source intent

## 15.4 Open Decision

Whether generated output should be:

- written to disk
- virtualized internally
- exposed only in debug mode

is still open.

For early development, **visible generated artifacts** may be better for trust and debugging.

---

# 16. Editor Tooling Direction (TS Plugin / LSP)

## 16.1 Why It Matters

A compile-time-heavy framework becomes intimidating without editor support.

Editor tooling acts as the **human interface** for understanding framework semantics.

## 16.2 Early Features

| Feature | Priority |
| --- | --- |
| current module kind hover | high |
| invalid boundary diagnostics in editor | high |
| action symbol semantic hints | medium |
| quick fixes for common boundary mistakes | medium |

## 16.3 Example Hover

```
Module kind: client
Derived from path: src/features/shop/client/shop-button.tsx
Imports allowed: client, shared, generated client stubs
```

## 16.4 Long-Term Potential

- generated output tracing
- safe serialization hints
- server component boundary visualization
- feature graph exploration

---

# 17. Security Model

## 17.1 Security Philosophy

In Roblox, the client must not be trusted.

Aruna should make secure architecture easier by default by turning security-sensitive boundaries into explicit compiler-visible structure.

Security should not rely only on team discipline or comments. The framework should make unsafe architecture harder to write, easier to detect, and easier to review.

## 17.2 Threat Model

Aruna should assume that the client is fully untrusted.

A malicious or compromised client may:

- call remotes manually
- send malformed payloads
- spam remote calls
- replay request-like payloads
- lie about player identity, item ownership, currency, inventory state, or game progress
- inspect replicated objects
- attempt to call remotes out of intended UI flow
- attempt to exploit missing validation, missing rate limits, or authority logic accidentally placed in shared code

Aruna should not promise to make insecure game logic automatically secure, but it should reduce common architectural mistakes around remotes, module boundaries, and authority placement.

## 17.3 Trust Boundaries

| Category | Trust Level | Examples |
| --- | --- | --- |
| server modules | trusted | authoritative game logic, validated server state, server-only services |
| server-injected context | trusted | `ctx.player`, server time, server-owned dependencies, validated service adapters |
| generated server registries | trusted framework surface | generated remote registration, action dispatch tables, manifest-backed handlers |
| shared modules | conditionally trusted | pure functions, schemas, types, serializable constants |
| client modules | untrusted | UI state, client-selected IDs, client-side caches, local prediction |
| remote payloads | untrusted | all client-to-server input, even when generated stubs are used |
| replicated objects | untrusted as authority | objects visible to clients should not be treated as proof of ownership or permission |

Design rule:

> Player identity and authority context should come from the server, not from client-provided payloads.
> 

## 17.4 Server Authority Rules

Aruna should encourage server-authoritative patterns.

Required direction:

- privileged logic stays in `server` modules
- clients call generated stubs, not raw server implementations
- remote/action handlers receive `ctx.player` from Aruna/server runtime
- client input may select an intent, but the server decides whether the intent is allowed
- shared modules must not contain authority-bearing state, secrets, or server-only service access

Bad pattern:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: z.object({
    player: PlayerSchema,
    itemId: z.string(),
    price: z.number(),
  }),
});
```

Preferred pattern:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: s.object({
    itemId: s.string(),
  }),
});

purchaseItem.handle(async (ctx, input) => {
  const player = ctx.player;
  return purchase(player, input.itemId);
});
```

## 17.5 Validation vs Authorization

Aruna should treat validation and authorization as separate concerns.

Validation answers:

> Is the payload shaped correctly?
> 

Authorization answers:

> Is this player allowed to perform this operation now?
> 

Example:

```tsx
export const purchaseItem = defineAction({
  input: PurchaseInput,
  output: PurchaseResult,
  authorize(ctx, input) {
    return canPurchase(ctx.player, input.itemId);
  },
  async run(ctx, input) {
    return purchase(ctx.player, input.itemId);
  },
});
```

Important rule:

- TypeScript types alone are not enough for remote boundaries because they do not exist at runtime.
- Remote and action inputs should use runtime-checkable schemas where validation matters.
- Authorization should be based on server-owned state, not client claims.

## 17.6 Remote Abuse Controls

Typed remotes should support abuse-control policies at the contract level.

Initial policy concepts:

- per-player rate limits
- burst limits
- cooldowns
- max payload size
- max concurrent requests per player
- request timeout
- optional failure logging

Example:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: PurchaseInput,
  output: PurchaseResult,
  rateLimit: {
    perPlayer: "10/10s",
    burst: 3,
  },
  limits: {
    maxPayloadBytes: 4096,
    maxConcurrentPerPlayer: 3,
    timeoutMs: 5000,
  },
});
```

These policies should be enforced on the server side. Client-side throttling may improve UX, but it must not be treated as security.

## 17.7 Raw Remote Usage Policy

Raw `RemoteEvent` / `RemoteFunction` usage is sometimes necessary, but it should not be the default path for Aruna-managed code.

Recommended policy:

- generated stubs are preferred for Aruna-managed remotes
- raw remote usage may be allowed for legacy integration or explicit escape hatches
- direct client calls to raw remotes should be diagnosable in strict mode
- raw remote usage should be visible in audit output when possible

Potential diagnostic:

```
warning aruna::507 raw-remote-event-used

Client code directly calls RemoteEvent.FireServer.
Prefer an Aruna generated remote stub so input validation, rate limiting,
and boundary metadata remain enforceable.
```

## 17.8 Security Manifest and Audit Output

Aruna should generate or expose enough metadata to support security review.

A future security manifest may include:

```json
{
  "remotes": [
    {
      "id": "shop.purchaseItem",
      "kind": "request",
      "inputSchema": "PurchaseInput",
      "outputSchema": "PurchaseResult",
      "rateLimit": "10/10s",
      "requiresPlayer": true,
      "handler": "src/server/shop-handlers.ts"
    }
  ]
}
```

Possible CLI direction:

```bash
aruna inspect security
```

This command could summarize:

- declared remotes
- action handlers
- missing schemas
- missing rate limits
- raw remote usage
- shared modules with suspicious server-only access
- authority-bearing code exposed to client or shared layers

## 17.9 Security Modes

Aruna should allow security strictness to be configured without making unsafe defaults attractive.

Possible modes:

| Mode | Behavior |
| --- | --- |
| `recommended` | Default mode. Enforces core boundary errors and warns on common remote/security issues. |
| `strict` | Turns more security smells into hard errors, including raw remote usage and suspicious shared authority patterns. |
| `audit` | Does not necessarily fail builds, but emits a security report for review. |
| `off` | Escape hatch for special cases. Should be documented as discouraged. |

Example config direction:

```tsx
export default defineConfig({
  security: {
    mode: "recommended",
  },
});
```

## 17.10 Security Rule Table

| Security Concern | Initial Strategy |
| --- | --- |
| client importing server implementation | hard error |
| authority logic accidentally shared | boundary analysis and shared safety diagnostics |
| remote boilerplate inconsistencies | typed remote contracts and generated registration |
| sensitive server internals exposed to client | avoid through action/stub model and import boundary checks |
| client-supplied player identity | reject or diagnose; use `ctx.player` instead |
| remote spam / abuse | server-side rate limits, burst limits, and request limits |
| unsafe serialized outputs | future stricter serialization checks |
| raw remote bypass | diagnose in strict mode and report in audit mode |

---

# 18. Roblox-Native Server Component (Future Concept)

## 18.1 Important Clarification

This is **not** intended as a direct copy of React Server Components on the web.

Roblox does not have the same SSR/hydration model.

## 18.2 Reinterpreted Direction

A future `server_component` concept could mean:

> a server-defined boundary that prepares safe UI-facing data or a safe view-model for client consumption
> 

Potential value:

- privilege-aware UI data shaping
- safer server-to-client view boundaries
- more explicit architecture for secure UI flows

## 18.3 Current Status

Interesting and potentially very powerful, but **not part of early implementation scope**.

---

# Part 5. Adoption & Roadmap

This part defines how Aruna should be adopted incrementally, what the MVP should prove, and how the project should evolve over time.

# 19. Incremental Adoption Strategy

## 19.1 Adoption Principle

This framework should not require a full rewrite to provide value.

## 19.2 Partial Adoption Candidates

| Capability | Can Be Adopted Alone? |
| --- | --- |
| boundary analysis | ✅ |
| import diagnostics | ✅ |
| action system | ✅ |
| generated bootstrap | ✅ |
| future server component model | ❌ early on |

## 19.3 Why This Matters

Early success is more likely if users can try **one useful piece** without migrating everything.

---

# 20. MVP Proposal

## 20.1 Included in MVP

- path-based module classification
- boundary import diagnostics
- transformed TS/TSX output compatible with roblox-ts
- minimal metadata generation

## 20.2 Excluded from MVP

- advanced directives
- full action system
- server component model
- advanced LSP
- serialization analysis

## 20.3 MVP Success Criteria

The MVP should make users think:

> “Even just for boundary management and diagnostics, this is already useful.”
> 

---

# 21. Roadmap Phases

## Phase 0 — Design Freeze

- finalize RFC
- finalize spec
- define boundary model
- define diagnostics philosophy
- define runtime principles

## Phase 1 — Minimal Core

- TS/TSX -> TS/TSX transformation pipeline
- path-based `client/server/shared` classification
- invalid import diagnostics
- minimal metadata

**Success condition:**
A small but real improvement in architecture safety and clarity.

## Phase 2 — Minimal Actions + Codegen

- `defineAction`
- generated client stubs
- generated server handlers
- basic bootstrap generation

**Success condition:**
Boilerplate begins to drop noticeably.

## Phase 3 — Editor Support

- TS Plugin / LSP basics
- in-editor boundary diagnostics
- module-kind hover
- basic quick fixes

**Success condition:**
The framework feels understandable, not scary.

## Phase 4 — Advanced Boundaries

- richer directives
- serialization-aware checks
- server component experiments
- advanced trace tooling

---

# Part 6. Phase 1 Implementation Contract

This part defines the first implementation contract for Aruna's compiler MVP.

The goal of Phase 1 is not to implement every long-term framework idea. The goal is to prove that Aruna can analyze real rbxts projects, classify modules, enforce client/server/shared boundaries, emit useful diagnostics, and produce inspectable metadata without requiring Roblox Studio.

## 22. Phase 1 Scope

Phase 1 should stay intentionally small.

Included:

- project config loading
- source file discovery
- path-based module classification
- basic directive recognition if implemented early
- static import graph construction
- client/server/shared boundary diagnostics
- minimal manifest generation
- CLI-based checking
- fixture-based compiler tests

Excluded:

- full typed remote implementation
- full action implementation
- generated remote registry
- generated action stubs
- advanced serialization analysis
- advanced LSP behavior
- full roblox-ts build orchestration
- custom Luau emission

Success condition:

> A real rbxts project can run `aruna check` and get accurate, actionable boundary diagnostics without opening Roblox Studio.
> 

## 23. CLI Command Contract

Phase 1 should expose a small CLI surface.

| Command | Phase 1 Role | Expected Behavior |
| --- | --- | --- |
| `aruna check` | primary command | Analyze the project, emit diagnostics, and exit non-zero when error-level diagnostics exist. |
| `aruna inspect` | debug / trust command | Print or write module classification, import graph, diagnostics, and manifest-like metadata. |
| `aruna build` | reserved | May later wrap codegen and roblox-ts build orchestration, but should not block Phase 1. |

Recommended Phase 1 commands:

```bash
aruna check
aruna inspect
aruna inspect --json
```

`aruna check` should be suitable for CI.

`aruna inspect` should be suitable for debugging why the compiler classified a file a certain way.

## 24. Compiler Input / Output

### 24.1 Inputs

The Phase 1 compiler should accept:

- project root
- config path or discovered config
- tsconfig path
- source file list derived from config / tsconfig
- optional include/exclude patterns
- optional strictness/security mode

Conceptual API:

```tsx
type CompilerInput = {
  projectRoot: string;
  configPath?: string;
  tsconfigPath?: string;
  files?: string[];
  mode?: "check" | "inspect";
};
```

### 24.2 Outputs

The Phase 1 compiler should produce:

- diagnostics
- module records
- import edges
- manifest metadata
- exit status for CLI usage

Conceptual API:

```tsx
type CompilerOutput = {
  diagnostics: Diagnostic[];
  modules: ModuleRecord[];
  imports: ImportEdge[];
  manifest: Manifest;
  hasErrors: boolean;
};
```

## 25. Module Classification Algorithm

Phase 1 classification should be predictable and explainable.

Recommended order:

1. normalize the source file path relative to project root
2. detect supported directives near the top of the file, if directive support is enabled
3. classify by path convention:
    - `**/client/**` -> `client`
    - `**/server/**` -> `server`
    - `**/shared/**` -> `shared`
4. compare directive classification with path classification
5. emit `aruna::201 conflicting-module-classification` when signals disagree
6. emit `aruna::203 ambiguous-convention-match` when multiple convention segments conflict
7. fall back to `unknown` when no supported signal exists
8. emit `aruna::200 unknown-module-kind` when an unknown file participates in boundary-relevant analysis

Examples:

| Path | Kind | Reason |
| --- | --- | --- |
| `src/client/app.tsx` | `client` | path convention |
| `src/server/bootstrap.server.ts` | `server` | path convention |
| `src/shared/constants.ts` | `shared` | path convention |
| `src/features/shop/client/panel.tsx` | `client` | feature-local path convention |
| `src/features/shop/server/pricing.ts` | `server` | feature-local path convention |

## 26. Import Resolution Scope

Phase 1 should support enough resolution to be useful, but avoid becoming a full package resolver immediately.

Supported in Phase 1:

- relative imports
- `.ts` and `.tsx` files
- `index.ts` and `index.tsx`
- basic tsconfig `baseUrl`
- basic tsconfig `paths`
- project-local source files

Deferred:

- dynamic import boundary analysis
- CommonJS `require` analysis
- deep node_modules semantic analysis
- complex conditional package exports
- generated virtual modules
- non-TypeScript asset imports unless explicitly configured

Resolution failures should not crash analysis. They should emit `aruna::105 unresolved-import` when the import is relevant to boundary analysis.

## 27. Boundary Validation Rules

Phase 1 should validate only the core client/server/shared matrix.

| Importer | Imported | Result | Diagnostic |
| --- | --- | --- | --- |
| `client` | `server` | error | `aruna::300 client-imports-server` |
| `server` | `client` | error | `aruna::301 server-imports-client` |
| `shared` | `client` | error | `aruna::302 shared-imports-client` |
| `shared` | `server` | error | `aruna::303 shared-imports-server` |
| `client` | `shared` | allowed | none |
| `server` | `shared` | allowed | none |
| `shared` | `shared` | allowed | none |

Generated client stubs and action/remote boundaries may be added in later phases.

## 28. Manifest Schema

Phase 1 should emit a small manifest that can later support inspect output, LSP metadata, security audit output, and code generation.

Initial shape:

```tsx
type Manifest = {
  version: 1;
  projectRoot: string;
  generatedAt?: string;
  modules: ModuleRecord[];
  imports: ImportEdge[];
  diagnostics: Diagnostic[];
};

type ModuleRecord = {
  id: string;
  path: string;
  kind: "client" | "server" | "shared" | "unknown";
  reason: "path" | "directive" | "fallback";
  reasonDetail?: string;
};

type ImportEdge = {
  from: string;
  to?: string;
  specifier: string;
  resolved: boolean;
  kind?: "static" | "dynamic";
};
```

Example:

```json
{
  "version": 1,
  "projectRoot": "/workspace/game",
  "modules": [
    {
      "id": "src/features/shop/client/panel.tsx",
      "path": "src/features/shop/client/panel.tsx",
      "kind": "client",
      "reason": "path",
      "reasonDetail": "matched **/client/**"
    }
  ],
  "imports": [
    {
      "from": "src/features/shop/client/panel.tsx",
      "to": "src/features/shop/server/pricing.ts",
      "specifier": "../server/pricing",
      "resolved": true,
      "kind": "static"
    }
  ],
  "diagnostics": []
}
```

Design rule:

> The manifest should explain what Aruna believed about the project, not just what it emitted.
> 

## 29. Test Fixture Matrix

Phase 1 should be built around fixture-based tests that do not require Roblox Studio.

Recommended fixtures:

| Fixture | Expected Result |
| --- | --- |
| `valid-client-imports-shared` | no diagnostics |
| `invalid-client-imports-server` | `aruna::300` |
| `invalid-server-imports-client` | `aruna::301` |
| `invalid-shared-imports-client` | `aruna::302` |
| `invalid-shared-imports-server` | `aruna::303` |
| `feature-local-layout` | correct feature-local classification |
| `unknown-module-kind` | `aruna::200` when boundary-relevant |
| `unresolved-import` | `aruna::105` |
| `tsconfig-path-alias` | resolved alias import |
| `conflicting-directive-and-path` | `aruna::201` if directives are enabled |
| `ambiguous-convention-match` | `aruna::203` |

Test outputs should snapshot:

- diagnostics
- module classification
- import graph
- manifest output

## 30. Exit Code Policy

CLI exit codes should be predictable for CI.

| Exit Code | Meaning |
| --- | --- |
| `0` | No error-level diagnostics. |
| `1` | One or more error-level diagnostics were emitted. |
| `2` | Invalid CLI usage or invalid configuration. |
| `3` | Internal compiler error. |

Warnings should not fail CI by default unless strict mode or a warning-as-error option is enabled.

## 31. Phase 1 Non-Negotiables

Phase 1 should not ship unless the following are true:

- diagnostics are stable enough to snapshot
- invalid boundary imports are caught reliably
- manifest output is inspectable
- fixture tests run without Roblox Studio
- errors explain both importer and imported module classifications
- unresolved imports do not crash the compiler
- internal compiler failures are reported as Aruna bugs, not user mistakes

---

# Part 7. Configuration Contract

This part defines Aruna's initial configuration contract.

Configuration should stay small, readable, and easy to copy into a new rbxts project. Aruna should prefer strong defaults and conventions, but still allow projects to override source layout, diagnostics, security mode, and manifest output when needed.

## 32. Config File

The default config file should be:

```
aruna.config.ts
```

Additional formats may be supported later, but `aruna.config.ts` should be the documented default.

Supported discovery order:

1. explicit CLI config path, if provided
2. `aruna.config.ts` in the current working directory
3. no config file, using defaults

Missing config should not be an error by itself. Missing required project inputs, such as `tsconfig.json`, may still produce diagnostics.

## 33. `defineConfig()` API

The public config helper should be named `defineConfig()`.

Example:

```tsx
import { defineConfig } from "aruna";

export default defineConfig({
  tsconfig: "tsconfig.json",

  source: {
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["node_modules/**", "out/**", ".aruna/**"],
  },

  conventions: {
    client: ["**/client/**"],
    server: ["**/server/**"],
    shared: ["**/shared/**"],
  },

  diagnostics: {
    warningsAsErrors: false,
  },

  security: {
    mode: "recommended",
  },

  manifest: {
    enabled: true,
    output: ".aruna/manifest.json",
  },
});
```

Design rule:

> `defineConfig()` should improve TypeScript inference and editor completion, but config should remain plain data wherever possible.
> 

## 34. Minimal Config

Most projects should not need a large config.

Recommended minimal form:

```tsx
import { defineConfig } from "aruna";

export default defineConfig({});
```

This should use defaults roughly equivalent to:

```tsx
export default defineConfig({
  tsconfig: "tsconfig.json",
  source: {
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["node_modules/**", "out/**", ".aruna/**"],
  },
  conventions: {
    client: ["**/client/**"],
    server: ["**/server/**"],
    shared: ["**/shared/**"],
  },
  diagnostics: {
    warningsAsErrors: false,
  },
  security: {
    mode: "recommended",
  },
  manifest: {
    enabled: true,
    output: ".aruna/manifest.json",
  },
});
```

## 35. Config Shape

Initial shape:

```tsx
type Config = {
  root?: string;
  tsconfig?: string;

  source?: {
    include?: string[];
    exclude?: string[];
  };

  conventions?: {
    client?: string[];
    server?: string[];
    shared?: string[];
  };

  diagnostics?: {
    warningsAsErrors?: boolean;
    ignore?: string[];
  };

  security?: {
    mode?: "recommended" | "strict" | "audit" | "off";
  };

  manifest?: {
    enabled?: boolean;
    output?: string;
  };
};
```

## 36. Root and tsconfig Discovery

`root` should default to the directory containing `aruna.config.ts`.

If no config file exists, `root` should default to the CLI current working directory.

`tsconfig` should default to:

```
tsconfig.json
```

If the configured or default tsconfig cannot be found, Aruna should emit:

```
aruna::102 missing-tsconfig
```

If the config file is malformed or unsupported, Aruna should emit:

```
aruna::100 invalid-config
```

## 37. Source Include / Exclude

Default source patterns:

```tsx
source: {
  include: ["src/**/*.ts", "src/**/*.tsx"],
  exclude: ["node_modules/**", "out/**", ".aruna/**"],
}
```

Source discovery should stay project-local by default. Aruna should avoid scanning build output, generated files, `node_modules`, or Rojo output folders unless explicitly configured.

## 38. Convention Patterns

Default convention patterns:

```tsx
conventions: {
  client: ["**/client/**"],
  server: ["**/server/**"],
  shared: ["**/shared/**"],
}
```

Projects may customize conventions for non-standard layouts:

```tsx
export default defineConfig({
  conventions: {
    client: ["src/client/**", "src/features/*/client/**"],
    server: ["src/server/**", "src/features/*/server/**"],
    shared: ["src/shared/**", "src/features/*/shared/**"],
  },
});
```

Design rule:

> Custom conventions should extend Aruna's usability, but the default mental model should remain `client / server / shared`.
> 

## 39. Diagnostics and Security Modes

Diagnostics config should control reporting behavior.

```tsx
diagnostics: {
  warningsAsErrors: false,
  ignore: [],
}
```

Security config should control security-specific strictness.

```tsx
security: {
  mode: "recommended",
}
```

Recommended interpretation:

| Mode | Behavior |
| --- | --- |
| `recommended` | Default. Enforce core boundary errors and warn on common security issues. |
| `strict` | Turn more security smells into hard errors. |
| `audit` | Prefer report output over build failure for security review workflows. |
| `off` | Escape hatch. Should be documented as discouraged. |

## 40. Manifest Output

Default manifest output:

```tsx
manifest: {
  enabled: true,
  output: ".aruna/manifest.json",
}
```

The manifest path should be project-local and ignored by source discovery by default.

The manifest should become the shared metadata surface for:

- `aruna inspect`
- fixture snapshots
- future LSP metadata
- future security audit output
- future code generation

## 41. Config Non-Goals

Initial config should avoid:

- plugin systems
- custom resolver hooks
- arbitrary user code execution during compiler-core analysis
- deeply nested framework options
- requiring config for ordinary projects

Config should exist to support real project variation, not to make every Aruna project feel manually wired.

---

# Part 8. Implementation Architecture

This part defines the initial implementation architecture for Aruna.

The goal is to keep the public user-facing package simple while allowing the internal implementation to remain modular, fast, and maintainable.

## 42. Monorepo Package Layout

Aruna should use a monorepo with a small number of clearly separated packages.

Recommended initial package layout:

```
packages/
  aruna/              public facade package and CLI entry
  core/               shared public types and stable contracts
  compiler/           JS wrapper around Rust compiler core
  runtime/            thin runtime helpers, reserved for later phases
  actions/            server action API, reserved for later phases
  lsp/                editor tooling, reserved for later phases
  test/               test utilities, reserved for later phases
  create/             project scaffolding, reserved for later phases

crates/
  aruna_compiler/     Rust compiler core
  aruna_napi/         Node native binding
  aruna_wasm/         optional future WASM target
```

Phase 1 should only implement the packages needed to prove the compiler MVP.

Phase 1 required packages:

```
aruna
@arunajs/core
@arunajs/compiler
```

Phase 1 reserved packages:

```
@arunajs/runtime
@arunajs/actions
@arunajs/lsp
@arunajs/test
@arunajs/create
```

Reserved packages may exist as stubs or may be created later. They should not block Phase 1.

## 43. Public Facade Package

The `aruna` package should be the primary user-facing package.

Responsibilities:

- expose the CLI binary
- expose `defineConfig()`
- re-export stable public types from `@arunajs/core`
- provide the default user-facing import path
- hide internal package complexity where possible

Example package role:

```
aruna
  bin: aruna
  exports:
    .              defineConfig, public types, future stable APIs
    ./config       config helper if needed later
```

User-facing examples should prefer:

```tsx
import { defineConfig } from "aruna";
```

Later framework APIs should also prefer `aruna` when possible:

```tsx
import { defineAction } from "aruna";
```

Design rule:

> Users should feel like they installed and use `aruna`, not a scattered collection of internal packages.
> 

## 44. Core Package Boundary

`@arunajs/core` should contain shared public contracts that are safe to import from multiple packages.

Responsibilities:

- config types
- diagnostic types
- manifest types
- module kind types
- shared utility types
- stable public data contracts

Possible exports:

```tsx
export type Config = { /* ... */ };
export type Diagnostic = { /* ... */ };
export type DiagnosticCode = `aruna::${number}`;
export type Manifest = { /* ... */ };
export type ModuleKind = "client" | "server" | "shared" | "unknown";
```

`@arunajs/core` should avoid depending on compiler internals or runtime-heavy packages.

Design rule:

> `@arunajs/core` should stay boring, stable, and mostly type/data oriented.
> 

## 45. Compiler Package Boundary

`@arunajs/compiler` should be the JavaScript/TypeScript-facing wrapper around the Rust compiler core.

Responsibilities:

- load the native compiler binding
- expose `checkProject()` / `inspectProject()`-style APIs
- normalize JS input into compiler-core input
- return plain JSON-compatible results
- avoid leaking raw native binding internals

Conceptual API:

```tsx
import type { CompilerInput, CompilerOutput } from "@arunajs/core";

export async function checkProject(input: CompilerInput): Promise<CompilerOutput>;

export async function inspectProject(input: CompilerInput): Promise<CompilerOutput>;
```

The compiler package should not own CLI formatting, terminal colors, or command parsing. Those belong in the `aruna` package.

Design rule:

> `@arunajs/compiler` should feel like a library API; `aruna` should feel like the user-facing CLI/product API.
> 

## 46. Rust Compiler Core

The Rust compiler core should own performance-sensitive analysis.

Responsibilities:

- source file loading or normalized source ingestion
- parser integration
- module classification
- import graph construction
- boundary validation
- diagnostic generation
- manifest data generation
- future semantic indexing

Rust module direction:

```
crates/aruna_compiler/src/
  lib.rs
  config.rs
  diagnostics.rs
  files.rs
  graph.rs
  manifest.rs
  module_kind.rs
  resolver.rs
  rules.rs
```

The internal module split should stay practical. Avoid excessive fragmentation before the compiler has real complexity.

Design rule:

> Rust owns hot-path analysis and deterministic compiler data; TypeScript owns ecosystem integration and user-facing ergonomics.
> 

## 47. TypeScript CLI Layer

The `aruna` package should own the CLI layer.

Responsibilities:

- parse CLI arguments
- discover and load `aruna.config.ts`
- discover project root and tsconfig path
- call `@arunajs/compiler`
- format diagnostics for humans
- write manifest output when requested
- produce stable exit codes

CLI command implementation direction:

```
aruna check
  -> load config
  -> call compiler.checkProject()
  -> print diagnostics
  -> exit 0/1/2/3

aruna inspect
  -> load config
  -> call compiler.inspectProject()
  -> print graph/manifest information
  -> optionally emit JSON
```

The CLI should avoid duplicating compiler rules. Rule decisions should come from the compiler core.

Design rule:

> The CLI presents results; the compiler decides results.
> 

## 48. Runtime Package Boundary

`@arunajs/runtime` should remain thin and should not be required for Phase 1 boundary diagnostics.

Future responsibilities:

- generated registry helpers
- remote/action runtime adapters
- request/response dispatch primitives
- server-injected context helpers
- testable runtime adapters for non-Studio tests

Non-goals:

- large DI container by default
- runtime module scanning
- reflection-heavy discovery
- hidden global registration as the primary model

Design rule:

> Runtime should execute what the compiler generated or described, not rediscover the application architecture at startup.
> 

## 49. Native Binary / WASM Distribution Strategy

Aruna should prefer a native compiler path for local CLI and editor tooling.

Initial direction:

- use Rust for compiler-core
- expose Node integration through a native binding package
- keep WASM as a future target for browser/docs/playground usage

Possible distribution shape:

```
@arunajs/compiler
  JS wrapper and loader

@arunajs/compiler-darwin-arm64
@arunajs/compiler-darwin-x64
@arunajs/compiler-linux-x64-gnu
@arunajs/compiler-linux-arm64-gnu
@arunajs/compiler-win32-x64-msvc
```

This mirrors the platform-specific native package strategy already proven useful in related tooling work.

Phase 1 does not need to finalize every target, but the architecture should avoid assuming a single platform binary.

Design rule:

> Native distribution should be boring for users: install `aruna`, run `aruna check`, and the correct compiler backend should be selected automatically.
> 

## 50. Public API vs Internal API

Aruna should explicitly separate public stable-ish APIs from internal unstable APIs.

Public stable-ish APIs:

- `defineConfig()`
- `Config`
- `Diagnostic`
- `Manifest`
- `ModuleKind`
- CLI commands documented for users

Internal unstable APIs:

- raw native binding shape
- graph internals
- resolver internals
- generated metadata internals
- compiler pipeline internals
- package-private helper modules

Public APIs can still evolve during early `0.x`, but the documentation should avoid accidentally presenting internals as stable extension points.

Design rule:

> If an API is not meant to be used by application developers, do not document it as a user-facing extension point.
> 

## 51. Internal Data Flow

Initial data flow:

```
aruna CLI
  -> load aruna.config.ts
  -> normalize compiler input
  -> call @arunajs/compiler
  -> @arunajs/compiler loads Rust native binding
  -> Rust compiler core analyzes project
  -> compiler returns diagnostics + graph + manifest
  -> CLI prints diagnostics / writes manifest / exits with code
```

The data returned across the JS/Rust boundary should remain JSON-compatible whenever possible.

Preferred boundary shape:

```tsx
type CompilerBridgeResult = {
  diagnostics: Diagnostic[];
  modules: ModuleRecord[];
  imports: ImportEdge[];
  manifest: Manifest;
};
```

Avoid passing complex class instances or runtime-heavy objects across the native boundary.

## 52. Phase 1 Implementation Scope

Phase 1 implementation should avoid overbuilding.

Implement now:

- `aruna` CLI with `check` and `inspect`
- `defineConfig()`
- `@arunajs/core` public data types
- `@arunajs/compiler` wrapper
- Rust compiler-core module classification
- import graph and boundary diagnostics
- manifest emission
- fixture tests

Do not implement yet:

- typed remote generation
- action stubs
- runtime dispatch
- LSP server
- create-app scaffolder
- browser/WASM playground
- plugin system

Phase 1 success condition:

> The package structure is real enough that later remotes/actions/LSP work can attach cleanly, but small enough that the first compiler MVP can ship without waiting for the whole framework.
> 

---

# Part 9. Code Generation Contract

This part defines how Aruna should generate files, where generated files should live, and how generated output should relate to manifests, imports, tests, and future remotes/actions.

Code generation should be predictable, inspectable, and conservative. Aruna should generate enough structure to remove boilerplate and enforce boundaries, but it should avoid hiding application behavior behind opaque magic.

## 53. Codegen Philosophy

Aruna codegen should follow these principles:

- generated files are framework-owned
- generated output should be deterministic
- generated output should be easy to inspect when debugging
- generated output should avoid requiring users to edit generated files manually
- generated output should support fixture tests and CI snapshots
- generated output should stay minimal in Phase 1
- codegen should make runtime behavior simpler, not more mysterious

Design rule:

> Aruna should generate boring, readable glue code that removes repetitive wiring while preserving traceability.
> 

## 54. Generated Output Directory

Default generated output should live under:

```
.aruna/
```

Recommended structure:

```
.aruna/
  manifest.json
  generated/
    client/
    server/
    shared/
```

Default config direction:

```tsx
export default defineConfig({
  manifest: {
    enabled: true,
    output: ".aruna/manifest.json",
  },
  codegen: {
    output: ".aruna/generated",
  },
});
```

The `.aruna/` directory should be excluded from source discovery by default to avoid analyzing generated files as user source.

Alternative output locations may be supported later for projects that need generated files inside `src/` for tooling/import reasons, but that should be explicit.

## 55. Generated File Ownership

Generated files are owned by Aruna.

Rules:

- users should not manually edit generated files
- generated files should include a clear header
- Aruna should avoid overwriting user-owned files
- generated output should be safe to delete and regenerate
- generated output should be ignored by ordinary source discovery unless explicitly configured

Recommended generated header:

```tsx
// Generated by Aruna. Do not edit manually.
// This file is derived from Aruna compiler metadata.
```

Generated files should not include timestamps by default, because timestamps make snapshots and CI diffs noisy.

## 56. Deterministic Output Rules

Generated output should be deterministic.

Rules:

- stable file ordering
- stable export ordering
- stable import ordering
- stable formatting
- stable generated IDs
- no random IDs
- no timestamps in generated source by default
- no machine-specific absolute paths in generated source by default

Manifest files may include optional metadata such as `generatedAt`, but generated TypeScript source should avoid unnecessary non-determinism.

Design rule:

> Regenerating the same project with the same inputs should produce the same generated files.
> 

## 57. Manifest and Generated Output Relationship

The manifest should be the source of truth for what Aruna understood about the project.

Generated code should be explainable from manifest data.

Relationship:

```
source files
  -> compiler analysis
  -> manifest metadata
  -> generated glue code
```

The manifest should help explain:

- why a module was classified as `client`, `server`, or `shared`
- which imports were accepted or rejected
- which remotes/actions were discovered in future phases
- which generated files were produced
- which diagnostics were emitted

Generated files should not be the only way to understand Aruna's decisions.

## 58. Generated Import Paths

Generated imports should be stable and framework-owned.

Long-term candidate import paths:

```tsx
import { remotes } from "$aruna/client";
import { actions } from "$aruna/actions";
```

Alternative candidates:

```tsx
import { remotes } from "aruna/generated/client";
import { remotes } from "./.aruna/generated/client";
```

Preferred long-term direction:

```
$aruna/client
$aruna/server
$aruna/actions
$aruna/remotes
```

This keeps generated project-local APIs visually distinct from normal package imports.

However, the exact alias should be finalized before typed remotes/actions ship. Phase 1 should avoid depending on a final generated import alias unless necessary.

Design rule:

> Generated import paths should look intentional, stable, and framework-owned, not like accidental relative paths into generated folders.
> 

## 59. Generated Code Debuggability

Generated code should be inspectable.

Recommended practices:

- include clear generated headers
- keep generated functions small
- preserve stable names derived from source identifiers
- avoid minified or overly clever generated code
- include source references in comments only when useful and deterministic
- keep manifest references available for tooling and diagnostics

Example generated source reference:

```tsx
// source: src/remotes/shop.ts#purchaseItem
```

Debuggability matters because generated code becomes part of the developer's trust model. If users cannot inspect what Aruna generated, they will not trust compiler-driven architecture.

## 60. Phase 1 Codegen Scope

Phase 1 should avoid heavy code generation.

Included in Phase 1:

- manifest generation
- optional JSON output for `aruna inspect --json`
- optional minimal generated metadata if required for tests

Excluded from Phase 1:

- typed remote registry generation
- client remote stubs
- server remote registration
- action client stubs
- action server dispatch tables
- generated Roblox instance tree bootstrap
- generated LSP semantic index beyond manifest-compatible metadata

Phase 1 should prove analysis and diagnostics first. Codegen should not block the compiler MVP.

## 61. Future Codegen Scope

Future phases can expand codegen gradually.

Phase 2 typed remotes:

```
source remote contracts
  -> remote manifest
  -> generated client remote stubs
  -> generated server remote registration
  -> runtime remote tree bootstrap
```

Phase 3 actions:

```
source action definitions
  -> action manifest
  -> generated client action stubs
  -> generated server dispatch table
  -> typed runtime dispatch
```

Future generated outputs may include:

- remote registry
- client remote stubs
- server remote registration
- action client stubs
- action server dispatch tables
- security audit metadata
- editor semantic metadata
- generated type declaration helpers

## 62. Generated File Conflict Policy

Aruna should avoid overwriting user-owned files.

Potential conflict cases:

- configured codegen output points to a user-owned directory
- generated file path already exists without an Aruna generated header
- generated file was manually edited
- generated output path escapes the project root

Relevant diagnostics:

```
aruna::703 generated-file-conflict
aruna::705 codegen-target-outside-root
```

Recommended behavior:

- hard error when a generated target file exists without an Aruna header
- hard error when output escapes project root
- safe overwrite when file has a recognized Aruna generated header
- clear message explaining which path is unsafe and how to fix config

## 63. Codegen Config Shape

Initial config extension:

```tsx
type Config = {
  codegen?: {
    output?: string;
    clean?: boolean;
  };
};
```

Recommended defaults:

```tsx
codegen: {
  output: ".aruna/generated",
  clean: false,
}
```

`clean: true` may later allow Aruna to remove stale generated files inside the owned generated output directory, but it should never delete user-owned files.

## 64. Codegen Non-Goals

Initial codegen should avoid:

- hiding business logic inside generated files
- generating large framework runtimes
- rewriting arbitrary user modules unexpectedly
- relying on generated files as the only source of truth
- creating non-deterministic output that makes CI noisy
- requiring users to edit generated files

Design rule:

> Generated code should be disposable, reproducible, and explainable.
> 

---

# Part 10. Typed Remote Contract

This part defines Aruna's typed remote model.

Typed remotes are the low-level network boundary layer underneath higher-level actions. They should reduce boilerplate, make network surfaces visible to the compiler, and provide a stronger security foundation for client/server communication.

Typed remotes should not be treated as a convenience wrapper only. They are part of Aruna's security and architecture model.

## 65. Remote Contract Philosophy

Roblox remotes are powerful, but raw `RemoteEvent` / `RemoteFunction` usage can easily become inconsistent, unsafe, or difficult to audit.

Aruna typed remotes should provide:

- explicit source-level remote contracts
- compiler-visible network boundaries
- generated client stubs
- generated server registration
- runtime input validation at the server boundary
- server-injected context such as `ctx.player`
- optional output validation
- rate limit and abuse-control metadata
- inspectable remote manifests
- a foundation for future `defineAction()` APIs

Design rule:

> A remote boundary should be declared once, validated by the compiler, generated consistently, and handled through server-authoritative code.
> 

## 66. Remote Declaration Location

Aruna should support both project-level and feature-local remote declarations.

Recommended declaration locations:

```
src/remotes/**/*.ts
src/features/**/remotes/**/*.ts
src/features/**/remotes.ts
```

Examples:

```
src/remotes/chat.ts
src/remotes/shop.ts
src/features/inventory/remotes/equip-item.ts
src/features/shop/remotes.ts
```

Remote declaration files should be treated as boundary contract files, not ordinary shared utilities.

Design rule:

> Remote declarations should be easy to find during security review.
> 

## 67. Remote Primitive Types

Initial remote primitives:

| API | Purpose | Default Direction | Notes |
| --- | --- | --- | --- |
| `defineRemoteEvent` | fire-and-forget event | client -> server initially | Good for signals that do not need a response. |
| `defineRemoteRequest` | typed request/response boundary | client -> server initially | Preferred high-level primitive for operations that return a result. |
| `defineRemoteFunction` | optional raw RemoteFunction wrapper | TBD | Possible escape hatch, but should not be the default abstraction. |

Initial implementation should focus on:

```
defineRemoteEvent
defineRemoteRequest
```

`defineRemoteFunction` may be deferred until the project has clearer evidence that raw RemoteFunction semantics are needed.

## 68. `defineRemoteEvent()`

`defineRemoteEvent()` represents a typed fire-and-forget remote signal.

Example:

```tsx
// src/remotes/chat.ts
import { defineRemoteEvent } from "aruna";
import { ChatMessageInput } from "../shared/chat-schema";

export const messageSent = defineRemoteEvent({
  input: ChatMessageInput,
  security: {
    requirePlayer: true,
    rejectUnknownFields: true,
  },
  rateLimit: {
    perPlayer: "20/10s",
    burst: 5,
  },
});
```

Client usage:

```tsx
import { remotes } from "$aruna/client";

remotes.chat.messageSent.fire({
  text: "hello",
});
```

Server handler:

```tsx
import { messageSent } from "../remotes/chat";

messageSent.handle((ctx, input) => {
  processChatMessage(ctx.player, input.text);
});
```

Expected generated client shape:

```tsx
remotes.chat.messageSent.fire(input);
```

## 69. `defineRemoteRequest()`

`defineRemoteRequest()` represents a typed request/response operation.

Example:

```tsx
// src/remotes/shop.ts
import { defineRemoteRequest } from "aruna";
import { PurchaseInput, PurchaseResult } from "../shared/shop-schema";

export const purchaseItem = defineRemoteRequest({
  input: PurchaseInput,
  output: PurchaseResult,
  security: {
    requirePlayer: true,
    rejectUnknownFields: true,
  },
  rateLimit: {
    perPlayer: "10/10s",
    burst: 3,
  },
});
```

Client usage:

```tsx
import { remotes } from "$aruna/client";

const result = await remotes.shop.purchaseItem({
  itemId: "sword",
});
```

Server handler:

```tsx
import { purchaseItem } from "../remotes/shop";

purchaseItem.handle(async (ctx, input) => {
  return purchase(ctx.player, input.itemId);
});
```

Expected generated client shape:

```tsx
const result = await remotes.shop.purchaseItem(input);
```

`defineRemoteRequest()` should not require users to decide whether the internal transport uses `RemoteFunction` or request/response `RemoteEvent` pairs. Aruna may choose the implementation strategy while keeping the public contract stable.

Design rule:

> Prefer a stable Aruna request API over exposing raw Roblox transport details too early.
> 

## 70. Remote Contract Shape

Initial conceptual shape:

```tsx
type RemoteSecurityPolicy = {
  requirePlayer?: boolean;
  rejectUnknownFields?: boolean;
  validateInput?: "server" | "both";
  validateOutput?: "server" | "dev" | "off";
};

type RemoteRateLimitPolicy = {
  perPlayer?: string;
  burst?: number;
};

type RemoteLimitsPolicy = {
  maxPayloadBytes?: number;
  maxConcurrentPerPlayer?: number;
  timeoutMs?: number;
};

type DefineRemoteRequestOptions<Input, Output> = {
  input: Input;
  output: Output;
  security?: RemoteSecurityPolicy;
  rateLimit?: RemoteRateLimitPolicy;
  limits?: RemoteLimitsPolicy;
};
```

The exact schema type should remain flexible until Aruna chooses or abstracts over a runtime validation library.

Important rule:

> TypeScript types alone are not enough for remote boundary security. Remote input validation must be runtime-checkable when the value crosses from client to server.
> 

## 71. Server Handler Contract

Server handlers should receive server-owned context and validated input.

Recommended handler form:

```tsx
remote.handle(async (ctx, input) => {
  // ctx is server-injected
  // input has passed boundary validation
});
```

Initial context direction:

```tsx
type RemoteContext = {
  player: Player;
  requestId?: string;
  remoteId: string;
};
```

Rules:

- `ctx.player` is injected by the server runtime
- handlers should not accept `Player` from client input
- handlers should be testable with mocked context outside Roblox Studio when logic is not engine-dependent
- handlers should be registered on the server side only
- client imports of handler implementation should be blocked or diagnosed in later phases

Bad pattern:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: s.object({
    player: s.player(),
    itemId: s.string(),
  }),
});
```

Preferred pattern:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: s.object({
    itemId: s.string(),
  }),
});

purchaseItem.handle(async (ctx, input) => {
  return purchase(ctx.player, input.itemId);
});
```

## 72. Client Stub Contract

Clients should call generated stubs instead of raw remote instances.

Preferred long-term import direction:

```tsx
import { remotes } from "$aruna/client";
```

Generated client surface example:

```tsx
remotes.shop.purchaseItem({ itemId: "sword" });
remotes.chat.messageSent.fire({ text: "hello" });
```

Rules:

- client stubs should expose typed APIs
- client stubs should not expose raw `RemoteEvent` / `RemoteFunction` instances by default
- client stubs may perform optional client-side validation for better developer feedback
- server-side validation remains authoritative even when client-side validation exists
- generated client APIs should be deterministic and stable

Design rule:

> Client stubs are ergonomic handles to server boundaries, not proof that client input is trustworthy.
> 

## 73. Runtime Validation Policy

Remote validation should happen at the server boundary.

Initial policy:

- validate input on the server
- optionally validate input on the client for developer feedback
- optionally validate output in development or strict mode
- reject or strip unknown fields based on policy
- never trust TypeScript-only types at runtime

Suggested defaults:

| Concern | Recommended Default |
| --- | --- |
| server input validation | enabled |
| client input validation | optional / dev-oriented |
| output validation | dev or strict mode |
| unknown fields | reject in strict mode, configurable in recommended mode |
| validation failure | reject request and optionally audit/log |

Validation should be designed with performance in mind, especially for high-frequency remotes.

## 74. Rate Limit and Abuse Policy

Typed remotes should support server-side abuse controls.

Policy concepts:

- per-player rate limits
- burst limits
- cooldowns
- max payload size
- max concurrent requests per player
- request timeout
- optional failure logging

Example:

```tsx
export const purchaseItem = defineRemoteRequest({
  input: PurchaseInput,
  output: PurchaseResult,
  rateLimit: {
    perPlayer: "10/10s",
    burst: 3,
  },
  limits: {
    maxPayloadBytes: 4096,
    maxConcurrentPerPlayer: 3,
    timeoutMs: 5000,
  },
});
```

Rules:

- rate limits must be enforced on the server
- client-side throttling may improve UX but should not be treated as security
- remotes that mutate authoritative state should strongly consider rate limits
- audit mode should be able to report remotes without rate limits

## 75. Remote Manifest Shape

Typed remotes should appear in the Aruna manifest.

Conceptual shape:

```tsx
type ArunaRemoteRecord = {
  id: string;
  kind: "event" | "request" | "function";
  source: string;
  exportName: string;
  inputSchema?: string;
  outputSchema?: string;
  requiresPlayer: boolean;
  rateLimit?: string;
  handler?: string;
  generated?: {
    clientStub?: string;
    serverRegistration?: string;
  };
};
```

Example manifest entry:

```json
{
  "id": "shop.purchaseItem",
  "kind": "request",
  "source": "src/remotes/shop.ts",
  "exportName": "purchaseItem",
  "inputSchema": "PurchaseInput",
  "outputSchema": "PurchaseResult",
  "requiresPlayer": true,
  "rateLimit": "10/10s",
  "handler": "src/server/shop-handlers.ts",
  "generated": {
    "clientStub": ".aruna/generated/client/remotes.ts",
    "serverRegistration": ".aruna/generated/server/remotes.ts"
  }
}
```

The manifest should make network surface area reviewable through future commands such as:

```bash
aruna inspect security
aruna inspect remotes
```

## 76. Generated Remote Tree

Aruna should generate or bootstrap a predictable Roblox remote tree.

Potential Roblox tree:

```
ReplicatedStorage/
  Aruna/
    Remotes/
      shop/
        purchaseItem
      chat/
        messageSent
```

Rules:

- server bootstrap owns remote creation
- client runtime waits for the generated/declared remote tree
- remote instance names should be deterministic
- remote IDs should be stable across builds unless source contract identity changes
- generated tree should be inspectable in Studio during debugging

Open question:

- whether remote instance names should use nested folders, flat dotted names, or a hybrid model

Initial preference:

```
ReplicatedStorage/Aruna/Remotes/<namespace>/<remoteName>
```

## 77. Remote Diagnostics

Remote-specific diagnostics should live in the `aruna::500` range.

Candidate diagnostics:

```
aruna::500 invalid-remote-definition
aruna::501 duplicate-remote-id
aruna::502 remote-input-schema-missing
aruna::503 remote-output-schema-invalid
aruna::504 remote-handler-missing
aruna::505 client-imports-remote-handler
aruna::506 remote-input-uses-player
aruna::507 raw-remote-event-used
aruna::508 remote-rate-limit-missing
aruna::509 unsafe-remote-output
```

Recommended severity direction:

| Diagnostic | Recommended Severity |
| --- | --- |
| `invalid-remote-definition` | error |
| `duplicate-remote-id` | error |
| `remote-input-schema-missing` | warning or error in strict mode |
| `remote-handler-missing` | warning or error depending on remote kind and phase |
| `client-imports-remote-handler` | error |
| `remote-input-uses-player` | error |
| `raw-remote-event-used` | warning, error in strict mode |
| `remote-rate-limit-missing` | info/warning, stricter for mutating operations later |

## 78. Phase 2 Remote Scope

Typed remotes should not block Phase 1.

Phase 2 included scope:

- detect remote declarations
- emit remote manifest records
- generate client stubs
- generate server registration glue
- bootstrap predictable remote tree
- validate input server-side
- support basic rate limit metadata
- support fixture tests without Roblox Studio for generated output

Phase 2 excluded scope:

- full action system
- advanced serialization analysis
- complex bidirectional streaming
- cross-server messaging
- plugin-defined transports
- complete LSP visualization

Success condition:

> A project can declare typed remotes in source, generate stable client/server glue, and route client calls through server-validated handlers without manually creating raw RemoteEvent boilerplate.
> 

## 79. Remote Non-Goals

Typed remotes should avoid:

- making client input trustworthy
- hiding authorization inside generated code
- requiring users to edit generated remote files
- forcing every existing legacy remote to migrate immediately
- exposing raw Roblox remote instances as the default API
- choosing a transport abstraction that cannot evolve
- making high-frequency gameplay networking slower through unnecessary validation in hot paths

Design rule:

> Aruna typed remotes should make the safe path easier without pretending that networking security is automatic.
> 

---

# Part 11. Server Action Contract

This part defines Aruna's server action model.

Server actions are the high-level business operation layer built on top of typed remotes. They should express server-authoritative intent, validation, authorization, execution, generated client access, diagnostics, and manifest metadata in a way that remains testable without Roblox Studio whenever possible.

Typed remotes answer:

> How does a client safely cross the network boundary?
> 

Server actions answer:

> What authoritative server operation is the client allowed to request?
> 

## 80. Action Philosophy

Actions should represent meaningful server-authoritative operations, not raw transport details.

Examples:

- `purchaseItem`
- `equipItem`
- `claimQuestReward`
- `sendChatMessage`
- `saveSettings`

Actions should provide:

- explicit input and output contracts
- server-side validation
- optional authorization hook
- server-injected context
- generated client stubs
- generated server dispatch
- manifest metadata for inspection and audit
- testable business logic boundaries

Design rule:

> Actions should model business intent. Typed remotes should model network transport boundaries.
> 

## 81. Relationship to Typed Remotes

Actions should be implemented on top of typed remotes internally, but users should not need to think about remote transport details for ordinary business operations.

Layering:

```
client code
  -> generated action client stub
  -> typed remote request boundary
  -> generated server action dispatch
  -> action authorize(ctx, input)
  -> action run(ctx, input)
```

Conceptual relationship:

| Layer | Purpose |
| --- | --- |
| typed remote | network boundary, transport, validation, rate limits, generated remote tree |
| server action | business operation, authorization, authoritative state mutation, domain workflow |

Design rule:

> Actions may use typed remotes internally, but action APIs should remain stable even if the underlying remote transport strategy changes.
> 

## 82. `defineAction()`

`defineAction()` should define a server-authoritative operation.

Example:

```tsx
// src/features/shop/server/purchase-action.ts
import { defineAction } from "aruna";
import { PurchaseInput, PurchaseResult } from "../shared/purchase-schema";
import { canPurchase, purchase } from "./purchase-service";

export const purchaseItem = defineAction({
  input: PurchaseInput,
  output: PurchaseResult,

  authorize(ctx, input) {
    return canPurchase(ctx.player, input.itemId);
  },

  async run(ctx, input) {
    return purchase(ctx.player, input.itemId);
  },
});
```

Client usage:

```tsx
import { actions } from "$aruna/actions";

const result = await actions.shop.purchaseItem({
  itemId: "sword",
});
```

`defineAction()` should be optimized for the common case where the client requests a server-owned operation and receives a typed result.

## 83. Action Declaration Location

Actions should live in server-owned locations.

Recommended locations:

```
src/actions/**/*.ts
src/server/actions/**/*.ts
src/features/**/server/**/*action.ts
src/features/**/actions/**/*.ts
```

Examples:

```
src/actions/save-settings.ts
src/server/actions/grant-reward.ts
src/features/shop/server/purchase-action.ts
src/features/inventory/actions/equip-item.ts
```

Action implementation files should be classified as `server` or action-specific server boundary files.

Rules:

- action implementation must not be imported directly by client modules
- generated client stubs are the client-facing access path
- action source files should be easy to find during security review
- action declarations should be visible to compiler analysis

## 84. Action Input / Output Schema

Actions should have runtime-checkable input schemas when crossing from client to server.

Conceptual shape:

```tsx
type DefineActionOptions<Input, Output> = {
  input: Input;
  output: Output;
  authorize?: (ctx: ActionContext, input: Input) => boolean | Promise<boolean>;
  run: (ctx: ActionContext, input: Input) => Output | Promise<Output>;
};
```

Important rule:

> TypeScript types alone are not enough for action boundary security. Action inputs should be runtime-checkable because they originate from untrusted clients.
> 

Output schemas may be used for:

- development-time validation
- strict mode validation
- documentation and generated metadata
- future serialization analysis

## 85. Action Context

Actions should receive server-owned context.

Initial context direction:

```tsx
type ActionContext = {
  player: Player;
  actionId: string;
  requestId?: string;
};
```

Future context may include:

- logger
- time provider
- request metadata
- dependency adapters
- feature flags
- testing hooks

Rules:

- `ctx.player` is injected by server runtime
- client must not provide player identity through action input
- action business logic should use server-owned state for authority decisions
- context should be mockable for Studio-independent tests

Bad pattern:

```tsx
export const purchaseItem = defineAction({
  input: s.object({
    player: s.player(),
    itemId: s.string(),
  }),
  async run(ctx, input) {
    return purchase(input.player, input.itemId);
  },
});
```

Preferred pattern:

```tsx
export const purchaseItem = defineAction({
  input: s.object({
    itemId: s.string(),
  }),
  async run(ctx, input) {
    return purchase(ctx.player, input.itemId);
  },
});
```

## 86. Validation and Authorization Contract

Actions should separate validation from authorization.

Validation answers:

> Is the payload shaped correctly?
> 

Authorization answers:

> Is this player allowed to perform this operation now?
> 

Execution answers:

> What authoritative server-side state change or result should happen?
> 

Recommended action flow:

```
receive request
  -> validate input
  -> construct ctx
  -> authorize(ctx, input)
  -> run(ctx, input)
  -> validate output if enabled
  -> return result
```

`authorize()` should be optional but strongly encouraged for actions that mutate authoritative state or expose sensitive data.

Rules:

- validation failure should reject the request before `authorize()` or `run()`
- authorization failure should not call `run()`
- `run()` should not assume client claims are true
- authorization should use server-owned state and `ctx.player`

Example:

```tsx
export const claimQuestReward = defineAction({
  input: ClaimQuestRewardInput,
  output: ClaimQuestRewardResult,

  authorize(ctx, input) {
    return canClaimReward(ctx.player, input.questId);
  },

  async run(ctx, input) {
    return claimReward(ctx.player, input.questId);
  },
});
```

## 87. Client Stub Contract

Client modules should call generated action stubs.

Preferred long-term import direction:

```tsx
import { actions } from "$aruna/actions";
```

Generated client shape:

```tsx
const result = await actions.shop.purchaseItem({ itemId: "sword" });
await actions.settings.saveSettings({ theme: "dark" });
```

Rules:

- generated action stubs should be typed
- generated action stubs should not expose raw remote instances by default
- stubs may perform optional client-side validation for better feedback
- server-side validation remains authoritative
- client stubs should map to manifest-backed action IDs
- action implementation modules should not be directly imported by client code

Design rule:

> Client action calls should feel like normal async function calls while still crossing a generated, validated server boundary.
> 

## 88. Server Dispatch Contract

Server dispatch should be generated from action metadata.

Conceptual generated flow:

```
registered action manifest
  -> generated server dispatch table
  -> remote request arrives
  -> lookup action by id
  -> validate input
  -> run authorize
  -> run action
  -> return output
```

Server dispatch should be:

- deterministic
- manifest-backed
- testable without Roblox Studio where possible
- explicit enough to debug
- thin enough to avoid becoming a large runtime container

Example conceptual dispatch table:

```tsx
export const actionHandlers = {
  "shop.purchaseItem": purchaseItem,
  "settings.saveSettings": saveSettings,
};
```

The generated dispatch table should not hide business logic. It should only route validated requests to declared actions.

## 89. Action Manifest Shape

Actions should appear in the Aruna manifest.

Conceptual shape:

```tsx
type ActionRecord = {
  id: string;
  source: string;
  exportName: string;
  inputSchema?: string;
  outputSchema?: string;
  hasAuthorize: boolean;
  handler: string;
  remoteId?: string;
  generated?: {
    clientStub?: string;
    serverDispatch?: string;
  };
};
```

Example manifest entry:

```json
{
  "id": "shop.purchaseItem",
  "source": "src/features/shop/server/purchase-action.ts",
  "exportName": "purchaseItem",
  "inputSchema": "PurchaseInput",
  "outputSchema": "PurchaseResult",
  "hasAuthorize": true,
  "handler": "src/features/shop/server/purchase-action.ts",
  "remoteId": "actions.shop.purchaseItem",
  "generated": {
    "clientStub": ".aruna/generated/client/actions.ts",
    "serverDispatch": ".aruna/generated/server/actions.ts"
  }
}
```

The manifest should make action surface area reviewable through future commands such as:

```bash
aruna inspect actions
aruna inspect security
```

## 90. Action Diagnostics

Action-specific diagnostics should use the `aruna::550`-`aruna::599` range.

Candidate diagnostics:

```
aruna::550 invalid-action-definition
aruna::551 action-missing-run
aruna::552 action-run-not-function
aruna::553 action-input-schema-invalid
aruna::554 action-output-schema-invalid
aruna::555 duplicate-action-id
aruna::556 action-imported-from-invalid-environment
aruna::557 missing-generated-action-stub
aruna::558 missing-server-action-handler
aruna::559 action-uses-client-only-api
aruna::560 action-input-uses-player
aruna::561 action-missing-authorization
```

Recommended severity direction:

| Diagnostic | Recommended Severity |
| --- | --- |
| `invalid-action-definition` | error |
| `action-missing-run` | error |
| `action-input-schema-invalid` | error |
| `duplicate-action-id` | error |
| `action-imported-from-invalid-environment` | error |
| `action-uses-client-only-api` | error |
| `action-input-uses-player` | error |
| `action-missing-authorization` | info/warning, stricter for mutating operations later |

## 91. Phase 3 Action Scope

Actions should not block Phase 1 or typed remotes.

Phase 3 included scope:

- detect `defineAction()` declarations
- emit action manifest records
- generate client action stubs
- generate server dispatch table
- route actions over typed remote request layer
- validate action input server-side
- support `authorize(ctx, input)`
- support `run(ctx, input)`
- support fixture tests without Roblox Studio for generated output and dispatch behavior

Phase 3 excluded scope:

- advanced server component model
- complex streaming actions
- optimistic update framework
- full transactional data model
- automatic authorization inference
- plugin-defined action transports
- complete LSP visualization

Success condition:

> A project can declare server actions, call generated typed client stubs, and execute server-authoritative business logic through validated dispatch without manually writing remote boilerplate.
> 

## 92. Action Non-Goals

Actions should avoid:

- making client input trustworthy
- replacing explicit authorization decisions
- hiding business logic in generated code
- forcing every remote to become an action
- requiring users to edit generated action files
- making actions feel like magic global RPCs without visible source declarations
- coupling public action APIs too tightly to raw Roblox transport details

Design rule:

> Actions should make the secure business-operation path easy while keeping authority, validation, and generated boundaries visible.
> 

---

# Part 12. Serialization and Schema Contract

This part defines Aruna's serialization and runtime schema model.

Typed remotes and server actions require runtime validation, but Aruna should not assume a web/Node-first validation library such as Zod will be suitable for rbxts/Luau runtime use.

Aruna should provide or define a Roblox-friendly schema system designed for roblox-ts, Luau output, network payload validation, and predictable runtime cost.

## 93. Schema Philosophy

Aruna schemas should be:

- runtime-checkable in Roblox/Luau
- friendly to roblox-ts output
- small enough for hot network paths
- serializable into compiler metadata when useful
- usable from shared modules
- understandable in generated diagnostics
- independent from heavyweight web-first validation assumptions

Design rule:

> Aruna should own its remote/action boundary schema model instead of depending on a Node/browser-first schema library as the core runtime contract.
> 

## 94. Aruna Schema API Direction

The schema API should be compact and rbxts-friendly.

Preferred import direction:

```tsx
import { schema as s } from "aruna";
```

Example:

```tsx
export const PurchaseInput = s.object({
  itemId: s.string(),
});

export const PurchaseResult = s.object({
  ok: s.boolean(),
  newBalance: s.number(),
});
```

Type inference direction:

```tsx
type PurchaseInput = InferSchema<typeof PurchaseInput>;
type PurchaseResult = InferSchema<typeof PurchaseResult>;
```

The exact type helper name can be finalized later, but the design should support deriving TypeScript types from schema definitions.

Possible schema primitives:

```tsx
s.string()
s.number()
s.boolean()
s.literal(value)
s.optional(schema)
s.array(schema)
s.object(shape)
s.record(keySchema, valueSchema)
s.union([...])
s.enum([...])
s.instanceOf("BasePart") // strict / advanced / use carefully
```

The schema runtime should avoid relying on features that are awkward or expensive after roblox-ts compilation.

## 95. Runtime Schema Requirement

Remote/action input schemas should be runtime-checkable because client input is untrusted.

Required direction:

- client-to-server payloads should be validated on the server
- TypeScript-only types are not enough at remote/action boundaries
- schema definitions should be usable in `shared` modules
- validation failures should produce structured errors and diagnostics where possible
- schemas should be inspectable enough for manifest metadata and future tooling

Design rule:

> A type that disappears after TypeScript compilation is not a security boundary.
> 

## 96. Client-to-Server Input Rules

Client-to-server input should be treated as untrusted even when generated stubs are used.

Rules:

- validate input at the server boundary
- reject malformed payloads before calling `authorize()` or `run()`
- avoid accepting authority-bearing fields from the client
- do not accept `Player` as a payload field
- prefer server-owned lookup by ID over trusting replicated objects
- enforce payload size and shape limits where possible

Bad pattern:

```tsx
export const PurchaseInput = s.object({
  player: s.player(),
  itemId: s.string(),
  price: s.number(),
});
```

Preferred pattern:

```tsx
export const PurchaseInput = s.object({
  itemId: s.string(),
});

purchaseItem.handle(async (ctx, input) => {
  return purchase(ctx.player, input.itemId);
});
```

## 97. Server-to-Client Output Rules

Server-to-client output should be intentionally shaped.

Rules:

- return serializable view data, not server authority internals
- avoid returning secrets, raw service objects, or server-owned mutable state
- prefer stable IDs and plain values
- output validation may be enabled in development, strict mode, or selected high-risk boundaries
- output schemas should be useful for generated client typings and docs

Example:

```tsx
export const PurchaseResult = s.object({
  ok: s.boolean(),
  itemId: s.string(),
  newBalance: s.number(),
});
```

## 98. Allowed Value Types

Initial allowed payload types should stay conservative.

Recommended allowed types:

| Type | Allowed? | Notes |
| --- | --- | --- |
| string | yes | Good for IDs, keys, names, enum-like values. |
| number | yes | Validate ranges for economy, quantity, and coordinates. |
| boolean | yes | Safe plain primitive. |
| array | yes, constrained | Should validate element type and length when relevant. |
| object/table | yes, constrained | Prefer object-like tables with known fields. |
| literal / enum | yes | Useful for intent fields and mode selection. |
| nil / undefined-like absence | only through optional | Prefer explicit optional fields over ambiguous payload shape. |

## 99. Disallowed or Dangerous Value Types

Some values should not cross remote/action boundaries by default.

Recommended disallowed or restricted types:

| Type | Default Policy | Reason |
| --- | --- | --- |
| function | disallowed | Not a serializable data contract. |
| thread | disallowed | Runtime execution state should not be payload data. |
| RBXScriptConnection | disallowed | Runtime object, not boundary data. |
| userdata | restricted | Must be explicitly modeled if supported. |
| Instance | restricted | Can be passed by Roblox, but should not be trusted as authority. |
| Player | disallowed in client payloads | Use server-injected `ctx.player` instead. |
| secret-bearing state | disallowed | Should not be exposed to client payloads. |

## 100. Roblox Instance Boundary Policy

Roblox `Instance` values require special care.

A client may be able to reference replicated instances, but that does not prove ownership, permission, or authority.

Default policy:

- do not accept `Player` through payload schemas
- avoid accepting arbitrary `Instance` values from clients
- prefer stable IDs, server-owned keys, or enum-like intent fields
- allow explicit instance schemas only for carefully reviewed cases
- strict mode may warn or error on instance payloads unless explicitly allowed

Bad pattern:

```tsx
export const EquipInput = s.object({
  item: s.instance(),
});
```

Preferred pattern:

```tsx
export const EquipInput = s.object({
  itemId: s.string(),
});

export const equipItem = defineAction({
  input: EquipInput,
  async run(ctx, input) {
    return equipByServerOwnedItemId(ctx.player, input.itemId);
  },
});
```

Design rule:

> Instance references can identify objects, but they should not be treated as proof of authority.
> 

## 101. Unknown Field Policy

Unknown fields should be handled explicitly.

Possible policies:

| Policy | Meaning | Use Case |
| --- | --- | --- |
| `reject` | fail validation when extra fields exist | strict security-sensitive inputs |
| `strip` | remove extra fields before handler execution | recommended default candidate |
| `passthrough` | allow extra fields | rare escape hatch |

Initial recommendation:

- recommended mode may default to `strip`
- strict mode should prefer `reject`
- security-sensitive actions/remotes should prefer `reject`

## 102. Validation Performance Policy

Validation is security-sensitive, but it can become expensive on hot paths.

Policy direction:

- validate server input by default
- keep schema runtime small and predictable
- support shallow fast paths for simple payloads
- support reusable compiled validators if useful
- avoid excessive allocations in common remote paths
- allow output validation to be dev/strict-only where appropriate
- document performance tradeoffs honestly

Design rule:

> Validation should be strong enough to protect boundaries and small enough to be acceptable in real Roblox gameplay paths.
> 

## 103. Schema Manifest Metadata

Schemas should be represented in manifest metadata when useful.

Conceptual shape:

```tsx
type ArunaSchemaRecord = {
  id: string;
  source: string;
  exportName: string;
  kind: "object" | "array" | "union" | "enum" | "primitive";
  usedBy: string[];
};
```

Remote/action manifest records may reference schemas by source/export name instead of embedding every schema detail initially.

This supports:

- `aruna inspect security`
- generated docs later
- LSP hover later
- fixture snapshots
- schema usage audits

## 104. Serialization Diagnostics

Serialization and schema diagnostics should live in the `aruna::600` range.

Candidate diagnostics:

```
aruna::600 non-serializable-action-input
aruna::601 non-serializable-action-output
aruna::602 unsafe-instance-cross-boundary
aruna::603 authority-bearing-shared-state
aruna::604 shared-imports-roblox-service
aruna::605 shared-has-environment-side-effect
aruna::606 secret-exposed-to-client
aruna::607 missing-runtime-schema
aruna::608 schema-uses-unsupported-type
aruna::609 payload-accepts-player
aruna::610 unknown-field-policy-unsafe
```

Recommended severity direction:

| Diagnostic | Recommended Severity |
| --- | --- |
| `missing-runtime-schema` | warning, error in strict mode |
| `schema-uses-unsupported-type` | error |
| `payload-accepts-player` | error |
| `unsafe-instance-cross-boundary` | warning, error in strict mode |
| `secret-exposed-to-client` | error when confidently detected |

## 105. Phase 2/3 Serialization Scope

Serialization should grow alongside typed remotes and actions.

Phase 2 typed remotes:

- define Aruna schema API
- validate remote input server-side
- represent remote schemas in manifest metadata
- support fixture tests for validation success/failure
- diagnose missing or unsafe schemas in strict mode

Phase 3 actions:

- validate action input server-side
- support action output schemas
- support authorization before `run()` after input validation
- add schema references to action manifest records
- add action-specific schema diagnostics

Deferred:

- advanced schema optimizer
- full static serialization proof system
- complex recursive schemas
- arbitrary Roblox userdata schemas
- automatic authority inference

Success condition:

> Aruna can validate client-provided remote/action input at runtime using a Roblox-friendly schema system, without depending on a web-first validation library as the core contract.
> 

## 106. Schema Non-Goals

Initial schema design should avoid:

- becoming a full Zod clone
- depending on Node/browser runtime assumptions
- making TypeScript-only types look like security boundaries
- accepting arbitrary Instances as trusted authority
- validating every output in production by default without considering cost
- supporting every possible Luau userdata shape from day one
- hiding validation behavior from generated diagnostics and inspect output

Design rule:

> Aruna schemas should be small, explicit, Roblox-friendly, and security-oriented.
> 

---

# Part 13. CLI and Inspect UX Contract

This part defines Aruna's CLI and inspect user experience.

The Aruna CLI should feel modern, calm, fast, and product-quality. It should not feel like a raw compiler dump or a stiff enterprise tool.

Aruna diagnostics still need to be precise, but the presentation should feel friendly, polished, and easy to scan.

## 107. CLI UX Philosophy

The CLI should prioritize:

- clear hierarchy
- readable spacing
- calm language
- useful summaries
- actionable fixes
- modern terminal aesthetics
- tasteful brand expression
- low noise by default
- JSON output for tools and CI
- human output for developers

Design rule:

> Aruna CLI output should feel like a polished developer product, not a raw internal compiler trace.
> 

Good references in spirit:

- Vite-style short startup/check summaries
- Next.js-style product CLI friendliness
- Biome-style clear diagnostics
- Cargo-style reliability and structured command behavior

Aruna should avoid:

- wall-of-text compiler dumps
- overly academic wording
- noisy stack traces for user mistakes
- excessive uppercase labels
- making every output look like a fatal crash
- hiding actionable suggestions behind verbose logs

## 108. Modern Visual Style

Human-readable CLI output should use a modern, readable style.

The CLI may use:

- gradient headers
- subtle brand-colored section titles
- compact summary rows
- readable spacing
- tasteful symbols
- high-contrast diagnostics

Recommended style direction:

```
aruna check

  ✓ 42 modules analyzed
  ✓ 67 imports resolved
  ✕ 1 error found

error aruna::300 client-imports-server

  src/features/shop/client/panel.tsx
  imports server-only module:
  src/features/shop/server/pricing.ts

  why this matters
  Client modules cannot import authoritative server code directly.

  suggested fix
  Move shared pricing helpers into `shared/`, or expose the operation through an action.
```

The `aruna` header may use a tasteful gradient in supported terminals. Diagnostics themselves should remain highly readable and should not depend on gradient styling.

Design rule:

> Use modern visual design to create clarity and brand feeling, not to decorate errors at the cost of readability.
> 

## 109. Gradient and Color Policy

Aruna may use gradients for brand-level surfaces.

Good places for gradient/color:

- CLI logo or `aruna` header
- command title
- section divider
- successful summary accent
- selected interactive prompts in future commands

Bad places for gradient/color:

- diagnostic body text
- file paths that need copying
- diagnostic codes
- JSON output
- CI-only output
- stack traces or internal compiler errors

Candidate palette directions:

```
sunrise gradient
  #f6c177 -> #eb6f92 -> #9ccfd8

soft aurora
  #c4a7e7 -> #9ccfd8 -> #f6c177

minimal cyan
  #9ccfd8 -> #31748f
```

Color should reinforce structure:

- success: calm green or cyan accent
- warning: warm yellow/orange accent
- error: clear red/pink accent
- info: blue/cyan accent
- muted details: gray

Aruna should never communicate meaning through color alone.

## 110. Accessibility and Fallback Policy

Modern CLI output must degrade cleanly.

Required behavior:

- support `--no-color`
- respect the `NO_COLOR` environment variable
- avoid color when stdout is not a TTY unless explicitly forced
- avoid gradient in CI by default
- keep plain output readable without color
- do not rely on symbols as the only meaning carrier
- never include ANSI codes in JSON output

Plain fallback should still look intentional:

```
aruna check

  42 modules analyzed
  67 imports resolved
  1 error found

error aruna::300 client-imports-server

  src/features/shop/client/panel.tsx
  imports server-only module:
  src/features/shop/server/pricing.ts
```

Design rule:

> Gradient is a presentation enhancement. Plain output is still a first-class experience.
> 

## 111. Symbols and Iconography

Symbols may be used sparingly.

Possible symbols:

```
✓ success
⚠ warning
✕ error
• detail
```

Rules:

- symbols should be optional presentation
- avoid emoji-heavy diagnostics
- avoid decorative symbols inside JSON or CI machine output
- keep symbol usage consistent
- always include text labels such as `error`, `warning`, or `success`

## 112. `aruna check` Output

`aruna check` should be the main Phase 1 command.

Successful output:

```
aruna check

  ✓ 42 modules analyzed
  ✓ 67 imports resolved
  ✓ no boundary errors found

  done in 84ms
```

Output with diagnostics:

```
aruna check

  42 modules analyzed
  67 imports resolved
  1 error found

error aruna::300 client-imports-server

  src/features/shop/client/panel.tsx is classified as client.
  It imports src/features/shop/server/pricing.ts, which is classified as server.

  suggested fix
  Move shared logic into `shared/`, or expose this operation through an action.
```

The default output should show enough context to fix the problem without overwhelming the user.

## 113. Diagnostic Rendering

Every rendered diagnostic should include:

- severity
- diagnostic code
- short name
- primary file
- what happened
- why it matters when useful
- suggested fix when available
- docs URL when available

Example:

```
error aruna::300 client-imports-server

  src/features/shop/client/panel.tsx
  imports server-only module:
  src/features/shop/server/pricing.ts

  why this matters
  Client code runs in an untrusted environment and cannot import server authority logic.

  suggested fix
  Move reusable logic into `shared/`, or expose the operation through an action.

  docs
  https://arunajs.dev/diagnostics/300
```

Rendering rules:

- show the most relevant diagnostic first
- group diagnostics by file when useful
- avoid repeating the same long explanation too many times
- keep suggestions concrete
- do not show internal stack traces unless the diagnostic is an internal compiler error

## 114. Error Tone

Aruna error messages should be direct but not hostile.

Prefer:

```
This file is classified as `client`, but it imports a `server` module.
```

Avoid:

```
Invalid boundary violation detected in module graph execution phase.
```

Prefer:

```
Move this helper into `shared/`, or call it through an action.
```

Avoid:

```
Refactor the dependency graph to satisfy the boundary validator.
```

Design rule:

> Diagnostics should sound like a helpful senior engineer, not a compiler panic.
> 

## 115. `aruna inspect` Overview

`aruna inspect` should help users understand what Aruna believes about the project.

Recommended subcommands:

```bash
aruna inspect
aruna inspect modules
aruna inspect graph
aruna inspect security
aruna inspect remotes
aruna inspect actions
aruna inspect --json
```

Phase 1 should prioritize:

```bash
aruna inspect modules
aruna inspect graph
aruna inspect --json
```

Future phases can add:

```bash
aruna inspect security
aruna inspect remotes
aruna inspect actions
```

## 116. `aruna inspect modules`

Example output:

```
module classification

client
  src/client/app.tsx
  src/features/shop/client/panel.tsx

server
  src/server/main.ts
  src/features/shop/server/pricing.ts

shared
  src/shared/schema.ts
  src/features/shop/shared/types.ts

unknown
  src/utils/debug.ts
```

Optional detailed mode:

```
src/features/shop/client/panel.tsx
  kind: client
  reason: matched **/client/**
```

## 117. `aruna inspect graph`

Example output:

```
import graph

src/features/shop/client/panel.tsx [client]
  -> src/features/shop/shared/schema.ts [shared] ok
  -> src/features/shop/server/pricing.ts [server] error aruna::300
```

The graph output should be readable for small projects and support JSON output for large projects.

## 118. `aruna inspect security`

Future security output should summarize the project's network/security surface.

Example:

```
security surface

remotes
  shop.purchaseItem
    input: PurchaseInput
    output: PurchaseResult
    rate limit: 10/10s
    handler: src/features/shop/server/purchase-action.ts

warnings
  aruna::508 remote-rate-limit-missing chat.messageSent
```

This command should help answer:

- what remotes exist?
- what actions exist?
- which handlers are registered?
- which inputs are validated?
- which remotes lack rate limits?
- where raw remote usage exists?

## 119. JSON Output Contract

Machine-readable output should be available through `--json`.

Examples:

```bash
aruna check --json
aruna inspect --json
aruna inspect modules --json
aruna inspect graph --json
```

JSON output should be stable and manifest-compatible.

Rules:

- no ANSI color codes in JSON
- no decorative symbols in JSON
- include diagnostic codes and names
- include module kind and classification reason
- include import graph edges
- include summary counts
- keep output deterministic for snapshots

Conceptual shape:

```tsx
type ArunaCliJsonOutput = {
  summary: {
    modules: number;
    imports: number;
    errors: number;
    warnings: number;
  };
  diagnostics: Diagnostic[];
  manifest?: Manifest;
};
```

## 120. CI Output Policy

CI output should be useful but not noisy.

Recommended behavior:

- disable gradient automatically in CI by default
- default human output is acceptable in CI
- `--json` is available for automation
- `--quiet` suppresses success details
- `--verbose` includes additional classification and resolver details
- warnings do not fail by default unless configured
- internal compiler errors include reproduction-friendly details

Useful flags:

```bash
aruna check --quiet
aruna check --verbose
aruna check --json
aruna check --warnings-as-errors
aruna check --no-color
```

## 121. Implementation Library Direction

The CLI should keep dependencies practical.

Possible TypeScript CLI libraries:

```
picocolors or kleur       color primitives
gradient-string           gradient header / brand title
boxen                     optional summary box, if useful
ora                       spinner for longer future commands only
cli-table3                inspect tables, if needed
```

Phase 1 should not over-invest in visual dependencies. A small color library plus an optional gradient header is enough.

Design rule:

> Visual polish should not make the CLI heavy, slow, or hard to maintain.
> 

## 122. Modern CLI Non-Goals

Aruna CLI should avoid:

- decorative output that makes errors harder to read
- emoji-heavy diagnostics
- hiding important details for style
- requiring color to understand output
- dumping internal compiler traces for ordinary user mistakes
- turning every command into an interactive wizard
- making CI output unstable or hard to parse
- adding visual dependencies that outweigh their value

Design rule:

> The CLI should be modern because it is clear, calm, fast, branded, and well-structured — not because it is flashy.
> 

---

# 123. Rule Summary Tables

## 22.1 Boundary Summary

| Rule | Result |
| --- | --- |
| `client` importing `server` | error |
| `server` importing `client` | error |
| `shared` importing `client` | error |
| `shared` importing `server` | error |
| `client` importing generated client stub | allowed |
| `server` importing `shared` | allowed |
| `client` importing `shared` | allowed |

## 22.2 Classification Summary

| Condition | Classification |
| --- | --- |
| under `client/` | `client` |
| under `server/` | `server` |
| under `shared/` | `shared` |
| explicit override via directive | override classification |

## 22.3 Directive Summary

| Directive | Meaning | Intended Usage |
| --- | --- | --- |
| `"use client";` | explicit client boundary | exception or UI boundary |
| `"use server";` | explicit server boundary | exception or server-special file |

---

# 23. Example Project Layout

## 23.1 Minimal Layout

```
src/
  client/
    app.tsx
  server/
    bootstrap.server.ts
  shared/
    constants.ts
```

## 23.2 Feature-Oriented Layout

```
src/
  features/
    inventory/
      client/
        inventory-panel.tsx
      server/
        inventory-service.ts
        equip-action.ts
      shared/
        inventory-schema.ts
        inventory-types.ts
```

---

# 24. Example Boundary Cases

## 24.1 Valid: client importing shared

```tsx
// src/features/inventory/client/inventory-panel.tsx
import { InventoryItemSchema } from "../shared/inventory-schema";
```

**Result:** valid

## 24.2 Invalid: client importing server implementation

```tsx
// src/features/inventory/client/inventory-panel.tsx
import { getInventoryForPlayer } from "../server/inventory-service";
```

**Result:** error

**Suggested fix:**
- move pure shared logic into `shared/`
- expose callable server logic through an action

## 24.3 Valid: server importing shared schema

```tsx
// src/features/inventory/server/equip-action.ts
import { EquipItemInput } from "../shared/inventory-schema";
```

**Result:** valid

## 24.4 Invalid: shared importing client UI code

```tsx
// src/features/inventory/shared/inventory-utils.ts
import { InventoryPanel } from "../client/inventory-panel";
```

**Result:** error

---

# 25. Example “Before vs After” API Direction

## 25.1 OOP / framework-heavy style

```tsx
@Service()
export class InventoryService {
  public getInventory(player: Player) {
    // ...
  }
}
```

## 25.2 Module-first direction

```tsx
// src/features/inventory/server/inventory-service.ts
export function getInventory(player: Player) {
  // ...
}
```

Possible future generated registration approach:

```tsx
export const inventoryService = defineServerModule({
  name: "inventory",
  exports: {
    getInventory,
  },
});
```

The exact API is still open, but the **direction** is:

- less class ceremony
- less framework-shaped code
- more plain TS module ergonomics

---

# 26. Open Questions

## 26.1 Directive Granularity

- file-level only?
- API-level hints?
- both?

## 26.2 Generated Output Strategy

- written files?
- virtual modules?
- hybrid?

## 26.3 Action Contract Style

- schema-first?
- type-first?
- hybrid?

## 26.4 Shared Purity Strictness

- warning-only first?
- hard error first?

## 26.5 Future Server Component Shape

- simple safe view-model factory?
- JSX-returning boundary?
- separate abstraction entirely?

## 26.6 Compiler <-> LSP Metadata Sharing

- shared semantic index?
- duplicated analysis?
- compiler-emitted metadata for editor consumption?

---

# 27. Implementation Guardrails

Before adding any new feature, evaluate it against these questions:

1. Does this make the system more **predictable**?
2. Does this belong at **compile time** rather than runtime?
3. Can the resulting behavior be **explained clearly in diagnostics**?
4. Can users **debug or inspect** what was generated?
5. Does this reduce runtime overhead without making DX worse?
6. Is this an MVP feature, or should it wait?
7. Does this reinforce the difference from OOP-heavy frameworks?

---

# 28. Current Conclusion

Aruna should begin as a **small, strong, architecture-oriented precompile layer** for rbxts projects.

Its early power should come from:

- clear boundary modeling
- compile-time diagnostics
- low runtime overhead
- deterministic transformation
- roblox-ts compatibility

Its long-term potential lies in:

- typed server actions
- generated architecture wiring
- strong editor integration
- security-aware boundaries
- a more cohesive full-stack Roblox development model

The first version should not try to be everything.
It should prove that this architecture direction is valuable with a minimal but compelling core.