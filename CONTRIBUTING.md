# Contributing to Aruna

Thanks for helping. This file covers how to build and test the repository, what to update
alongside a change, and how to report a problem. Security issues go through
[SECURITY.md](SECURITY.md), not public issues.

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 22 | what CI runs |
| pnpm | 11.5.1 (`packageManager` in `package.json`; `corepack enable` picks it up) | workspace install |
| Rust | stable | the native compiler (`crates/`, built through napi) |
| Lune | the version pinned in `rokit.toml` (`rokit install`) | runs the compiled Luau runtime specs; without it those suites skip themselves |

roblox-ts and the other JavaScript tools come from the workspace's own dependencies.

## Build and test

```bash
pnpm install
pnpm build
```

Run what CI runs (`.github/workflows/ci.yaml`) before you open a pull request:

```bash
cargo test --locked --all-targets
pnpm lint
pnpm typecheck
pnpm test
pnpm exec turbo run build --filter=@arunajs/aruna && pnpm api:check
pnpm verify:package-consumption
```

`pnpm test` builds the native compiler, every package, the vitest suites, the Luau
execution specs under Lune (`apps/roblox-runtime-test`), and the harness specs through
`aruna test`. `verify:package-consumption` packs the whole graph and drives the CLI against
a project outside the workspace; it is the slowest check and the only one that sees the
packages the way a user does.

CI runs on Linux and Windows. If you change anything that spawns processes or builds
paths, check both, or say in the pull request that you could not.

## What to update with a change

- **Public surface** (subpath exports, config, CLI flags and `--json` shapes, diagnostic
  codes, manifest and contract formats, generated file locations, wire and store formats):
  the full list is in [docs/stability.md](docs/stability.md#what-is-public-api).
  - Exports or types: run `pnpm api:report` and commit the changed `api/*.d.ts`. CI fails
    when the report is stale.
  - Add a line to [packages/aruna/CHANGELOG.md](packages/aruna/CHANGELOG.md).
- **Compiler output**: when a fixture's output changes on purpose, regenerate only that
  fixture's expectations and review the diff:

  ```bash
  pnpm --filter @arunajs/compiler exec tsx test/update-fixture-expectations.ts <fixture>
  ```

- **Diagnostic codes** are never reused, even for a retired diagnostic.
- **Store records**: [Persisted format v1](packages/aruna/docs/stores.md#persisted-format-v1)
  is permanent. Grow it only the way that page describes.
- **Wire protocol**: follow [docs/wire-protocol.md](docs/wire-protocol.md); a new item kind
  or field belongs in that document in the same change.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, for example `fix(compiler): …` or `feat(aruna): …`. Keep one
logical change per commit, and explain in the body why the change is needed.

A pull request should say what changed, how you checked it, and anything you could not
check (a platform, a Studio session).

## Releases

Maintainers publish through `.github/workflows/publish.yaml`. Every package in the graph
is released in lockstep at one version. A manual run publishes a canary; a `v*` tag on main
publishes stable. Either way the workflow first runs all of CI on the commit being
released. See [docs/stability.md](docs/stability.md) for what each release may change.

## Reporting a bug

Open an issue with:

- the `@arunajs/aruna` version (`npm ls @arunajs/aruna`), your OS and CPU, and your
  roblox-ts and TypeScript versions;
- the output of `aruna doctor`;
- the smallest project, or the steps from `create-aruna-app`, that reproduces it;
- what you expected and what happened, with the full error output.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) that covers this repository.
