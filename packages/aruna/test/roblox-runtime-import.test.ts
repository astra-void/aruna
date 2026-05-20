import { describe, expect, it, vi } from "vitest";

describe("aruna/roblox-runtime import safety", () => {
  it("can be imported in Node without Roblox globals", async () => {
    vi.resetModules();

    await expect(import("../roblox-runtime.js")).resolves.toMatchObject({
      DEFAULT_ARUNA_FOLDER_NAME: "Aruna",
      DEFAULT_ARUNA_ACTION_REMOTE_EVENT_NAME: "Actions",
    });
  });
});
