import { describe, expect, it, vi } from "vitest";

describe("aruna/roblox import safety", () => {
  it("can be imported in Node without Roblox globals", async () => {
    vi.resetModules();

    await expect(import("../roblox.js")).resolves.toMatchObject({
      ARUNA_FOLDER_NAME: "Aruna",
      ACTION_REMOTE_NAME: "Actions",
    });
  });
});
