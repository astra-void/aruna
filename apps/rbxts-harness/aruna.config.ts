export default {
  generatedDir: "src/shared/.aruna",
  manifest: {
    output: "src/shared/.aruna/manifest.json",
  },
  conventions: {
    client: ["src/client.tsx", "src/domains/**/ui.tsx"],
    server: ["src/server.ts", "src/domains/**/actions.ts"],
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
