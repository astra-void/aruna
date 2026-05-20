export const fixtureCases = [
  { name: "valid-client-imports-shared", mode: "inspect" },
  { name: "invalid-client-imports-server", mode: "inspect" },
  { name: "invalid-server-imports-client", mode: "inspect" },
  { name: "invalid-shared-imports-client", mode: "inspect" },
  { name: "invalid-shared-imports-server", mode: "inspect" },
  { name: "feature-local-layout", mode: "inspect" },
  { name: "unknown-module-kind", mode: "inspect" },
  { name: "unresolved-import", mode: "inspect" },
  { name: "missing-tsconfig", mode: "inspect" },
  { name: "config-define-config", mode: "inspect" },
  { name: "invalid-config", mode: "inspect" },
  { name: "invalid-tsconfig", mode: "inspect" },
  { name: "tsconfig-path-alias", mode: "inspect" },
  { name: "ambiguous-convention-match", mode: "inspect" },
  { name: "parse-failed", mode: "inspect" },
  { name: "action-basic", mode: "inspect" },
  { name: "action-rate-limit", mode: "inspect" },
  { name: "duplicate-action-id", mode: "inspect" },
  { name: "action-missing-run", mode: "inspect" },
  { name: "invalid-action-rate-limit", mode: "inspect" },
  { name: "client-imports-action-source", mode: "inspect" },
  { name: "virtual-generated-action-imports", mode: "inspect" },
  { name: "invalid-virtual-generated-action-imports", mode: "inspect" },
  { name: "action-generated-output", mode: "build" },
  { name: "action-generated-export-collision", mode: "build" },
] as const;

export type FixtureCase = (typeof fixtureCases)[number];

export const buildFixtureCases = fixtureCases.filter(
  (fixture): fixture is Extract<FixtureCase, { mode: "build" }> => fixture.mode === "build",
);
