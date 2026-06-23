import { describe, expect, it } from "vitest";
import {
  ARUNA_RUNTIME_MODULES,
  updateArunaRuntimePaths,
} from "../src/cli/tsconfig-paths.ts";

function runtimeAliasPaths(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const moduleName of ARUNA_RUNTIME_MODULES) {
    result[`aruna/${moduleName}`] = [`src/.aruna/runtime/${moduleName}.ts`];
  }
  return result;
}

describe("updateArunaRuntimePaths pruning", () => {
  it("removes stale aruna/* aliases, keeps current ones, leaves $aruna/* untouched", () => {
    const tsconfig = {
      compilerOptions: {
        paths: {
          // Stale runtime aliases from the 8 -> 4 consolidation.
          "aruna/client-runtime": ["src/.aruna/runtime/client-runtime.ts"],
          "aruna/server-app": ["src/.aruna/runtime/server-app.ts"],
          "aruna/server-runtime": ["src/.aruna/runtime/server-runtime.ts"],
          "aruna/runtime": ["src/.aruna/runtime/runtime.ts"],
          "aruna/roblox-runtime": ["src/.aruna/runtime/roblox-runtime.ts"],
          // A current runtime alias that already matches — should be kept as-is.
          "aruna/client": ["src/.aruna/runtime/client.ts"],
          // Action/signal virtual-module aliases must never be pruned.
          "$aruna/actions/client": ["src/.aruna/actions.client.generated.ts"],
          "$aruna/actions/server": ["src/.aruna/actions.server.generated.ts"],
          "$aruna/signals": ["src/.aruna/signals.generated.ts"],
        },
      },
    };

    const result = updateArunaRuntimePaths(tsconfig, runtimeAliasPaths(), {
      pruneStaleRuntimeAliases: true,
    });

    expect(result.changed).toBe(true);
    const paths = (JSON.parse(result.contents) as typeof tsconfig).compilerOptions.paths;

    // Stale aliases are gone.
    expect(paths["aruna/client-runtime"]).toBeUndefined();
    expect(paths["aruna/server-app"]).toBeUndefined();
    expect(paths["aruna/server-runtime"]).toBeUndefined();
    expect(paths["aruna/runtime"]).toBeUndefined();
    expect(paths["aruna/roblox-runtime"]).toBeUndefined();

    // The full expected runtime set is present.
    for (const moduleName of ARUNA_RUNTIME_MODULES) {
      expect(paths[`aruna/${moduleName}`]).toEqual([`src/.aruna/runtime/${moduleName}.ts`]);
    }

    // Action/signal aliases are untouched.
    expect(paths["$aruna/actions/client"]).toEqual(["src/.aruna/actions.client.generated.ts"]);
    expect(paths["$aruna/actions/server"]).toEqual(["src/.aruna/actions.server.generated.ts"]);
    expect(paths["$aruna/signals"]).toEqual(["src/.aruna/signals.generated.ts"]);
  });

  it("does not prune aruna/* aliases when pruning is disabled (default)", () => {
    const tsconfig = {
      compilerOptions: {
        paths: {
          "aruna/server-app": ["src/.aruna/runtime/server-app.ts"],
          "$aruna/signals": ["src/.aruna/signals.generated.ts"],
        },
      },
    };

    // Mirrors the signal-alias call in the doctor flow: it updates $aruna/signals
    // and must leave stale aruna/* aliases alone.
    const result = updateArunaRuntimePaths(tsconfig, {
      "$aruna/signals": ["src/.aruna/signals.generated.ts"],
    });

    const paths = (JSON.parse(result.contents) as typeof tsconfig).compilerOptions.paths;
    expect(paths["aruna/server-app"]).toEqual(["src/.aruna/runtime/server-app.ts"]);
    expect(result.changed).toBe(false);
  });

  it("reports no change when the expected runtime set is already exact", () => {
    const tsconfig = { compilerOptions: { paths: runtimeAliasPaths() } };
    const result = updateArunaRuntimePaths(tsconfig, runtimeAliasPaths(), {
      pruneStaleRuntimeAliases: true,
    });
    expect(result.changed).toBe(false);
  });
});
