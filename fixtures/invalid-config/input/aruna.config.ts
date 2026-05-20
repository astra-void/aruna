export default {
  generatedDir: "src/.aruna",
  manifest: {
    output: "src/.aruna/manifest.json",
  },
  conventions: {
    client: ["src/client.ts", "src/client.tsx"],
    server: ["src/server.ts", "src/server.tsx"],
    shared: ["src/shared/**"],
  },
};
