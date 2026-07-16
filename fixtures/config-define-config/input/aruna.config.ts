import { defineConfig } from "aruna";

export default defineConfig({
  compiler: {
    generatedDir: "src/.aruna",
    manifest: "src/.aruna/manifest.json",
  },
  actions: {
    defaultRateLimit: {
      key: "player",
      windowMs: 1000,
      max: 20,
    },
  },
  conventions: {
    client: ["src/client.ts"],
    server: ["src/server.ts"],
    shared: ["src/shared/**"],
  },
});
