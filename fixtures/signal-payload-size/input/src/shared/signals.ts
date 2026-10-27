import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

// Bounded and small: 4-byte frame header + 12 (vector3) + 1 (u8) + 4 + 16
// (string, maxLength 16) = 37 bytes. No diagnostic.
export const hit = defineSignal({
  id: "fx.hit",
  unreliable: true,
  wire: "binary",
  payload: schema.object({
    at: schema.vector3(),
    power: schema.u8(),
    by: schema.string().maxLength(16),
  }),
});

// An unbounded string: aruna::510 (warning).
export const chat = defineSignal({
  id: "chat.bubble",
  unreliable: true,
  payload: schema.object({ text: schema.string() }),
});

// 4 + 64 x (4 + 32) = 2308 payload bytes, 2312 with the frame header: over the
// 900-byte limit, aruna::511 (error).
export const trail = defineSignal({
  id: "fx.trail",
  unreliable: true,
  wire: "binary",
  payload: schema.array(schema.string().maxLength(32)).maxItems(64),
});

// Reliable signals are not size-checked.
export const log = defineSignal({
  id: "log.line",
  payload: schema.object({ text: schema.string() }),
});
