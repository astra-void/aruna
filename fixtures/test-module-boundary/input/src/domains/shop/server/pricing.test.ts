// A spec sitting next to the code it exercises: inside `server/`, and still
// classified as a test. The action it defines is a fixture, so it must not reach
// the manifest, the generated registry, or the contract.
import { defineAction } from "aruna/server";
import { createTestServerApp, expect, it } from "aruna/testing";
import { priceOf } from "./pricing";

const fixtureAction = defineAction({
  id: "shop.fixture",
  run: () => priceOf("sword"),
});

it("prices an item", async () => {
  const harness = createTestServerApp({ actions: { "shop.fixture": fixtureAction } });
  expect(priceOf("sword")).toBe(5);
  harness.dispose();
});
