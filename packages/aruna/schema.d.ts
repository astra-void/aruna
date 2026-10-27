// `aruna/schema` — declarations emitted from the native runtime (roblox/schema.ts).
// Type-only outside a roblox-ts build: the game compiles the vendored copy of
// the runtime that `aruna build` writes, never this package.
export * from "./dist/native/schema.js";
