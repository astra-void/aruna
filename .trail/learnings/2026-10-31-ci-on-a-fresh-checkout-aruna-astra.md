---
title: "CI on a fresh checkout: aruna bin, release-test race, Windows-only failures"
author: Astra-void
date: 2026-10-31
branch: prerelease/v1-formats
cost: { minutes: 53, tokens: 552783 }
touches:
  - ".gitattributes"
  - packages/aruna/bin/aruna.js
  - packages/aruna/package.json
  - packages/aruna/src/cli.ts
  - packages/aruna/test/bin.test.ts
  - packages/aruna/test/compiler-output-guard.test.ts
  - packages/compiler/scripts/build-native-target-core.ts
  - packages/compiler/scripts/stage-compiler-package.ts
  - packages/compiler/test/build-native-target.test.ts
  - packages/compiler/test/native-build.test.ts
  - packages/compiler/test/native-loader.test.ts
  - packages/compiler/test/native-staging.test.ts
  - packages/compiler/test/release.test.ts
  - scripts/release.ts
  - scripts/verify-package-consumption.ts
---

## Decided
- This supersedes 2026-10-31-running-the-full-suite-on-one: both problems it describes are fixed.
- packages/aruna's bin is the checked-in launcher `bin/aruna.js`, which imports `runCli` from ../dist/cli.js. pnpm links a workspace package's bin only when its target exists at install time and never relinks it (even `pnpm install --force` says "Already up to date"), so a bin pointing into dist/ left a fresh checkout without `aruna`; that is why CI's harness build failed on ubuntu and windows. No relink step is needed now; `aruna` still needs packages/aruna built, which turbo's ^build does.
- No test writes the repository's `.npm/` any more. runBuildNativeTarget takes `deps.workspaceRoot` and scripts/release.ts takes `ReleaseDeps.stagingRoot`, and their tests pass mkdtemp roots. The old race was build-native-target.test.ts removing the real `.npm/compiler` while release.test.ts staged there (11 of 15 runs failed; 0 of 15 after). A release.test.ts "Staged packages do not match the selected release targets" failure is now a real signal: look for a test touching the real `.npm/` before rerunning.
- verify-package-consumption builds core, compiler, and aruna before `build:native`, because build:native stages the compiler wrapper only when packages/compiler/dist exists.
- For Windows: fixtures/ is pinned to LF in .gitattributes (byte compares, and spans are byte offsets); compiler tests build expected paths with path.join; the output guard also matches the JSON-escaped root.

## Watch out
- Before this, CI never got past the harness build, so no vitest, Lune, or harness suite had completed in CI on either OS. The Windows fixes come from code review, not a Windows run: the first windows-latest run may still find more.
- Windows clones made before the LF pin keep CRLF fixtures until renormalized (`git add --renormalize fixtures`).
