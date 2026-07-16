// Everything a client author needs: the client app and the action invoker.
// Consolidated from the former /client, /client-runtime, and /runtime entry
// points. (The in-memory invoker is internal — test actions through
// `createServerApp(...).dispatch` instead.)
export * from "./app/client.js";
export * from "./runtime/client.js";
