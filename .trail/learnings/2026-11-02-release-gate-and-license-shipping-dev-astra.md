---
title: Release gate and license shipping (DEV-41/42)
author: Astra-void
date: 2026-11-02
branch: main
cost: { minutes: 30, tokens: 304253 }
touches:
  - README.md
  - docs/create-app-plan.md
  - docs/init-spec.md
  - docs/spec-alignment.md
  - CONTRIBUTING.md
  - SECURITY.md
  - ".github/workflows/ci.yaml"
  - ".github/workflows/publish.yaml"
  - docs/stability.md
  - packages/aruna/package.json
---

## Decided
- publish.yaml runs ci.yaml itself (`verify`, via `workflow_call`) plus a `release-ref` job before any native build. A `v*` tag must carry the version in all four package manifests and point at a commit on main. `workflow_dispatch` is canary-only; stable goes out only through a tag. `id-token: write` sits on the publish job alone.
- ci.yaml's concurrency group is `ci-${{ github.workflow }}-${{ github.ref }}`. When publish calls it, github.workflow is "publish", so a push to main cannot cancel a release run's gate and the group never matches publish's own `publish-<ref>` group (which would deadlock).
- The license is single-sourced: `packages/compiler/package.json`'s `license` is what validateStagedRelease requires of every staged package, and the repository LICENSE is copied into each one by scripts/release.ts (not by the stagers, whose tests use temp roots with no LICENSE). Native package dirs now hold package.json, LICENSE and the .node file; npm includes LICENSE whatever `files` says.

## Tried and ruled out
- Running oxfmt over scripts/release.ts or packages/compiler/test/release.test.ts: both already drift from the formatter, so it reflows unrelated lines. Format only what you add.
- Splitting a diff into hunks with `git diff -U0` and `git apply --unidiff-zero` misplaced an insertion next to an identical line. Check the result before trusting it.

## Watch out
- The new publish workflow has not run on GitHub yet. The first canary run is what proves the reusable call and its concurrency are accepted.
- SECURITY.md links to GitHub private vulnerability reporting, which is disabled on astra-void/aruna until the owner turns it on.
- trail check flags CONTRIBUTING/SECURITY/docs lines on keywords (`pnpm install`, "server-side validation"); these are false positives.
