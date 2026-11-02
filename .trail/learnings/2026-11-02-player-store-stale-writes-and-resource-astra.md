---
title: Player-store stale writes and resource liveness (DEV-24/25/23)
author: Astra-void
date: 2026-11-02
branch: main
cost: { minutes: 29, tokens: 158181 }
touches:
  - packages/aruna/docs/architecture.md
  - packages/aruna/docs/resources.md
  - apps/roblox-runtime-test/src/test/network.spec.ts
  - packages/aruna/docs/actions.md
  - packages/aruna/CHANGELOG.md
  - packages/aruna/roblox/server-runtime.ts
  - apps/roblox-runtime-test/src/test/resource.spec.ts
  - packages/aruna/roblox/resource.ts
  - apps/roblox-runtime-test/src/test/player-store.spec.ts
  - packages/aruna/docs/stores.md
---

## Decided
- player-store writeDocument refuses a readable record that carries no lock as well as one carrying another owner's lock: every open-document write happens under our lock, so "no lock" means another server took over and released. A retried release whose first attempt landed sees exactly our value (fingerprint match) and returns undefined (no write) instead of failing.
- flush returns StoreClosedError once the document is inactive; release itself goes through enqueue + writeDocument directly, not flush, so the guard does not block it.
- A player-scoped resource key stays linked while its load runs after the last unsubscribe; finish unlinks it when it lands with no subscribers. Global keys are never unlinked.
- Input validation in server-runtime runs under pcall: a throwing refine is ActionValidationError + invalid-input, not a rejected dispatch (the transport only answers settled results).
- Optimistic tags are capped at 32 per caller per key (resource.ts MAX_OPTIMISTIC_TAGS_PER_CALLER, unexported).

## Tried and ruled out
- Refusing undecodable records in writeDocument too: that would reverse the deliberate "lock holder overwrites a corrupt non-version-ahead record" policy, so only readable records are checked.

## Watch out
- A hung resource load wedges a global resource for the server's lifetime (new subscribers wait on the running load, even with a cached value). No framework timeout yet; docs tell users to bound load with Promise.timeout. Decision pending (DEV-25).
- Every registered action is callable by any client; there is no authorize/server-only. Decision pending (DEV-23).
- In the test network, invoke() needs net.flush() before await, or the spec hangs until aruna test's 120 s timeout.
