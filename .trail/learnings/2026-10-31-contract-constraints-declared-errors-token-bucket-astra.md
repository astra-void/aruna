---
title: "Contract constraints, declared errors, token bucket, abuse-front deltas"
author: Astra-void
date: 2026-10-31
branch: prerelease/v1-formats
cost: { minutes: 29, tokens: 299092 }
touches:
  - README.md
  - api/aruna-client.d.ts
  - api/aruna-roblox.d.ts
  - api/aruna-schema.d.ts
  - api/aruna-server.d.ts
  - api/aruna-testing.d.ts
  - api/aruna.d.ts
  - apps/package-consumption-harness/src/domains/shop/actions.ts
  - apps/package-consumption-harness/src/domains/shop/schema.ts
  - apps/rbxts-harness/src/domains/inventory/actions.ts
---

## Decided
- A pasted 5-item proposal list was partly stale: the request budget, requestId cap, and onAbuse already existed (hardening round), as did literal maxLength/maxItems + constraintsHash. Only the deltas were built.
- Schema constraints are recorded as raw declared values on SchemaMetadata (min/max, minLength/maxLength, minChars/maxChars, int, minItems/maxItems, maxEntries, a refinements count, dynamicConstraints); constraintsHash now covers only refine predicates and non-static arguments. maxLength no longer folds maxChars×4 — payload_size::max_string_bytes combines them.
- Contract snapshot is version 2. A v1 file is still read: both sides are compared with constraints stripped, plus one info entry (constraints-not-compared). Without that, every v1 baseline produced false "bound added" breaking entries, including in the store gate.
- Direction rules: tighter input = breaking; tighter output/payload/error data = non-breaking (and the reverse for looser); a changed predicate or computed bound = warning. The store gate treats every tightening (refine, int, min added) as breaking.
- The request budget refunds a call's token once its action's own rate limit admits it; otherwise the 30/s default throttled actions below their declared rate.
- Unknown action ids are dropped in registry.admitEnvelope (transport only); dispatch/dispatchInProcess still answer ActionNotFoundError.
- Declared errors: any public error whose name the action declares is validated against the declaration, whether thrown by ctx.fail or by an actionError from middleware. A mismatch is masked like a failing output.

## Tried and ruled out
- An optional `fail` on the erased action-map context: method bivariance then fails in both directions for an aruna/server defineAction (TPlayer unknown) put into a Player app. The erased type needs a required `fail`. Only the rbxts-harness build caught this; the type tests used aruna/roblox's Player-typed defineAction.
- Tying isActionError to the stub's action id at runtime would need a function-keyed registry. Kept a name-only check plus server-side validation of declared names.

## Watch out
- roblox-ts reserves `error` (and `next`) as identifiers; parameters named `error` compile in tsc but fail in rbxtsc.
- napi JSON comes out with alphabetical keys, while committed fixture expectations keep struct order. A fixture regenerator must write only files whose content changed and keep the existing key order, or diffs explode.
- Luau iterates object fields in no fixed order, so a "first schema issue" test must break exactly one field.
- `aruna inspect contract` used to print only counts when any diagnostic existed; the new aruna::514 warning would have hidden the summary everywhere. It now shows the summary when there are only warnings.
