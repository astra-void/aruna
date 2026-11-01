import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARUNA_RUNTIME_MODULES,
  arunaAliasTargets,
  isArunaOwnedAlias,
} from "../src/cli/tsconfig-paths.ts";

describe("arunaAliasTargets", () => {
  it("maps every Aruna alias into the split-tree generated dir", () => {
    const root = path.resolve("/project");
    const targets = arunaAliasTargets(root, "src/.aruna");

    expect(targets["$aruna/actions/client"]).toBe(
      path.join(root, "src/.aruna/shared/actions.client.generated.ts"),
    );
    expect(targets["$aruna/actions/server"]).toBe(
      path.join(root, "src/.aruna/server/actions.server.generated.ts"),
    );
    expect(targets["$aruna/signals"]).toBe(
      path.join(root, "src/.aruna/shared/signals.generated.ts"),
    );
    expect(targets["$aruna/resources/client"]).toBe(
      path.join(root, "src/.aruna/shared/resources.client.generated.ts"),
    );
    expect(targets["$aruna/resources/server"]).toBe(
      path.join(root, "src/.aruna/server/resources.server.generated.ts"),
    );
    for (const moduleName of ARUNA_RUNTIME_MODULES) {
      expect(targets[`aruna/${moduleName}`]).toBe(
        path.join(root, "src/.aruna/shared/runtime", `${moduleName}.ts`),
      );
    }
    expect(Object.keys(targets)).toHaveLength(5 + ARUNA_RUNTIME_MODULES.length);
  });
});

describe("isArunaOwnedAlias", () => {
  it("owns the $aruna/* virtual modules and the aruna/* runtime subpaths, nothing else", () => {
    expect(isArunaOwnedAlias("$aruna/signals")).toBe(true);
    expect(isArunaOwnedAlias("aruna/server")).toBe(true);
    // Including a runtime module the layout no longer has: the upkeep drops it.
    expect(isArunaOwnedAlias("aruna/server-app")).toBe(true);
    expect(isArunaOwnedAlias("@/*")).toBe(false);
    expect(isArunaOwnedAlias("arunax/foo")).toBe(false);
  });
});
