// Reference-vs-vendor export parity.
//
// The Node reference runtime (`src/**`) and the roblox-ts native vendor runtime
// (`roblox/**`) are different implementations, so their *internal* type surfaces
// legitimately differ (e.g. `RemoteEventClientLike` only exists in the reference
// runtime; `ActionMap` only in the vendor runtime). What must NOT drift is the
// consumer-facing CONTRACT: the symbols documented in `docs/**` and imported by
// consumer code. This test pins that contract per entry point and asserts every
// contract symbol is exported by BOTH runtimes.
//
// This is the regression guard for the original drift report: the turnkey
// `createSignalPublisher` / `createSignalSubscriber` helpers used to exist only
// in the vendor runtime, so reference docs named symbols the reference runtime
// did not export. Adding any of those to the contract below makes a one-sided
// export fail here.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Entry point -> [reference file, vendor file].
const ENTRIES = {
  "aruna/server": ["src/server.ts", "roblox/server.ts"],
  "aruna/client": ["src/client.ts", "roblox/client.ts"],
  "aruna/roblox": ["src/roblox.ts", "roblox/roblox.ts"],
  "aruna/schema": ["src/schema.ts", "roblox/schema.ts"],
} as const;

// The documented, consumer-facing public contract every entry must expose from
// both runtimes. Keep in sync with docs/**; a symbol here that one runtime drops
// fails this test.
const CONTRACT: Record<keyof typeof ENTRIES, readonly string[]> = {
  "aruna/server": [
    "defineAction",
    "defineSignal",
    "createServerApp",
    "ActionDefinition",
    "ActionRegistry",
    "ActionRateLimitOptions",
    "CreateServerAppOptions",
    "ServerApp",
    "ServerTransport",
    "ServerSignalPublisherFactory",
    "SignalDefinition",
    "InferInput",
    "InferOutput",
    "InferSignalPayload",
  ],
  "aruna/client": [
    "createClientApp",
    "invokeAction",
    "clearActionInvoker",
    "setActionInvoker",
    "ClientApp",
    "ClientTransport",
    "ActionInvoker",
    "ActionInvokeOptions",
    "CreateClientAppOptions",
  ],
  "aruna/roblox": [
    "defineAction",
    "defineSignal",
    "bindActions",
    "createActionInvoker",
    "robloxRemoteEvent",
    "createSignalPublisher",
    "createSignalSubscriber",
  ],
  "aruna/schema": ["schema", "Schema", "Infer", "NumberFormat", "SchemaLiteral"],
};

function exportNamesOf(relativeEntry: string): Set<string> {
  const absolute = path.join(packageRoot, relativeEntry);
  const program = ts.createProgram([absolute], {
    noLib: true,
    skipLibCheck: true,
    types: [],
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(absolute);
  if (sourceFile === undefined) {
    throw new Error(`Could not load entry source file: ${relativeEntry}`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new Error(`Entry is not a module: ${relativeEntry}`);
  }

  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()));
}

describe("reference/vendor export parity", () => {
  for (const [entry, [refFile, venFile]] of Object.entries(ENTRIES)) {
    const contract = CONTRACT[entry as keyof typeof ENTRIES];

    it(`exposes the full ${entry} contract from both runtimes`, () => {
      const reference = exportNamesOf(refFile);
      const vendor = exportNamesOf(venFile);

      const missingFromReference = contract.filter((name) => !reference.has(name));
      const missingFromVendor = contract.filter((name) => !vendor.has(name));

      expect({ entry, missingFromReference }).toEqual({ entry, missingFromReference: [] });
      expect({ entry, missingFromVendor }).toEqual({ entry, missingFromVendor: [] });
    });
  }
});
