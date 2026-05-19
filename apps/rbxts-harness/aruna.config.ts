export default {
  generatedDir: "src/.aruna",
  manifest: {
    output: "src/.aruna/manifest.json",
  },
  conventions: {
    client: ["src/client.tsx", "src/app/client-runtime.ts", "src/domains/**/ui.tsx"],
    server: ["src/server.ts", "src/app/server-runtime.ts", "src/domains/**/actions.ts"],
    shared: [
      "src/app/bootstrap.ts",
      "src/app/providers.ts",
      "src/shared/**",
      "src/domains/**/schema.ts",
      "src/domains/**/model.ts",
      "src/domains/**/runtime.ts",
    ],
  },
};
