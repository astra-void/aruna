// The CLI's primitive list (src/cli/primitives.ts) must match the compiler's
// registry (crates/aruna_compiler/src/primitives): same primitives, same order,
// and a contract entry exactly where the compiler marks IN_CONTRACT. Registering
// a primitive on one side only fails here.
import { loadNativeCompiler } from "@arunajs/compiler";
import { describe, expect, it } from "vitest";
import { PRIMITIVES } from "../src/cli/primitives.js";

type Descriptor = {
  readonly name: string;
  readonly callees: readonly string[];
  readonly definingModuleKind: string | null;
  readonly inContract: boolean;
};

describe("primitive registry", () => {
  const native = loadNativeCompiler();

  it("is exposed by the native compiler", () => {
    expect(typeof native.primitiveDescriptors).toBe("function");
  });

  it("lists the compiler's primitives in the compiler's order", () => {
    const descriptors = native.primitiveDescriptors() as Descriptor[];
    expect(PRIMITIVES.map((primitive) => primitive.name)).toEqual(
      descriptors.map((descriptor) => descriptor.name),
    );
  });

  it("puts exactly the IN_CONTRACT primitives in the contract", () => {
    const descriptors = native.primitiveDescriptors() as Descriptor[];
    for (const descriptor of descriptors) {
      const registration = PRIMITIVES.find((primitive) => primitive.name === descriptor.name);
      expect({ name: descriptor.name, inContract: registration?.contract !== undefined }).toEqual({
        name: descriptor.name,
        inContract: descriptor.inContract,
      });
    }
  });

  it("reports the callees and module kinds the docs describe", () => {
    const descriptors = native.primitiveDescriptors() as Descriptor[];
    expect(descriptors).toEqual([
      {
        name: "action",
        callees: ["defineAction"],
        definingModuleKind: "serverAction",
        inContract: true,
      },
      { name: "signal", callees: ["defineSignal"], definingModuleKind: null, inContract: true },
      {
        name: "store",
        callees: ["defineStore", "definePlayerStore"],
        definingModuleKind: "serverStore",
        inContract: true,
      },
      { name: "runtime", callees: ["defineRuntime"], definingModuleKind: null, inContract: false },
    ]);
  });
});
