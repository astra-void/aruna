// Aruna roblox-ts native runtime — the Instance names and defaults the Roblox
// transport is built on. Internal: `roblox.ts` and the specs read them; a game
// sees the names in the DataModel, documented in docs/wire-protocol.md.

// The one reliable remote: action calls one way; action responses and reliable
// signals the other, through one ordered channel per player
// (docs/wire-protocol.md).
export const REMOTE_NAME = "ArunaRemoteEvent";
export const SIGNAL_UNRELIABLE_REMOTE_NAME = "ArunaSignalUnreliableRemoteEvent";
// Attribute on the remote where the server advertises its contract hash, so a
// client with a mismatched compiled-in hash can detect a deploy skew.
export const CONTRACT_HASH_ATTRIBUTE_NAME = "ArunaContractHash";

// The default request timeout, applied when requestTimeoutMs is not given.
// Pass requestTimeoutMs: 0 to explicitly opt out (wait forever).
export const DEFAULT_ACTION_REQUEST_TIMEOUT_MS = 10_000;
