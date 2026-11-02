# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/astra-void/aruna/security/advisories/new)**
(the repository's Security tab → "Report a vulnerability").

Include what an attacker can do, the affected version or commit, and the steps or the
smallest project that reproduces it. You will get an acknowledgement, and the fix and any
advisory are coordinated with you before details are made public.

## What is in scope

Aruna is a server-authoritative framework, so the boundary between an untrusted client and
the server is the main thing to protect. In scope:

- a client making the server run an action, read state, or change state it should not:
  bypassing authorization, rate limits, request budgets, or input validation;
- one player receiving another player's player-scoped resource data;
- malformed or oversized wire input that crashes, stalls, or corrupts the server;
- store handling that loses, corrupts, or overwrites a saved record (session locks,
  migrations, the persisted format);
- the compiler or CLI writing or running something outside the project it was pointed at;
- the published npm packages and the release pipeline (`.github/workflows/publish.yaml`).

Out of scope: bugs in a game's own action handlers or authorization logic, and problems in
Roblox, roblox-ts, or Rojo themselves (report those upstream).

## Supported versions

Aruna has not had its first public release yet ([docs/stability.md](docs/stability.md)).
Until then, fixes land on `main` and ship in the next release; older versions and canaries
are not patched. This section will name the supported release lines once the first public
release is defined.
