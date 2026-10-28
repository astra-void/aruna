import { defineSignal } from "aruna/server";
import { schema } from "aruna/schema";

// Bounded and small: 4-byte frame header + 12 (vector3) + 1 (u8) + 4 + 16
// (string, maxLength 16) = 37 bytes, 118 with the wire frame. No diagnostic.
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

// 4 + 64 x (4 + 32) = 2308 payload bytes, 2312 with the frame header, 2395 with
// the wire frame (8 + 75): over the 900-byte limit, aruna::511 (error).
export const trail = defineSignal({
  id: "fx.trail",
  unreliable: true,
  wire: "binary",
  payload: schema.array(schema.string().maxLength(32)).maxItems(64),
});

// An 868-byte frame fits under 900 alone, but not with its wire frame
// ("fx.burst" 8 + 75 = 83): 951 bytes, aruna::511 (error).
export const burst = defineSignal({
  id: "fx.burst",
  unreliable: true,
  wire: "binary",
  payload: schema.array(schema.u8()).maxItems(860),
});

// The table encoding's floor, 4 + 616 + 82 (wire frame for "fx.near") = 702, is
// under the limit but over 75% of it; its real size is larger, so
// aruna::513 (warning) recommends wire: "binary".
export const near = defineSignal({
  id: "fx.near",
  unreliable: true,
  payload: schema.array(schema.u8()).maxItems(616),
});

// Reliable signals are not size-checked.
export const log = defineSignal({
  id: "log.line",
  payload: schema.object({ text: schema.string() }),
});
