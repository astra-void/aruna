import { defineConfig } from "aruna";

export default defineConfig({
  compiler: {
    generatedDir: "src/.aruna",
    manifest: "src/.aruna/manifest.json",
  },
  conventions: {
    client: ["src/client.ts", "src/client.tsx", "src/app/client.ts", "src/app/client.tsx"],
    server: ["src/server.ts", "src/server.tsx", "src/app/server.ts", "src/app/server.tsx"],
    shared: ["src/shared/**", "src/domains/**/model.ts"],
  },
});
