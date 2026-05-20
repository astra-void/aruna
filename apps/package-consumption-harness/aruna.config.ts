import { defineConfig } from "aruna";

export default defineConfig({
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
  conventions: {
    client: ["src/client.tsx", "src/domains/**/ui.tsx"],
    server: ["src/server.ts", "src/domains/**/actions.ts"],
    shared: ["src/app/**", "src/shared/**", "src/domains/**/schema.ts", "src/domains/**/model.ts"],
  },
});
