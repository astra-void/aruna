import { defineConfig } from "aruna";

export default defineConfig({
  entries: "generated",
  compiler: {
    generatedDir: "src/.aruna",
    manifest: "src/.aruna/manifest.json",
  },
  actions: {
    transport: "remote-event",
    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },
  },
});
