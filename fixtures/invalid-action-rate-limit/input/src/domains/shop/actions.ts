import { defineAction } from "aruna/server";

const dynamicWindowMs = 1000;

export const missingKey = defineAction({
  id: "shop.missingKey",
  rateLimit: {
    windowMs: 1000,
    max: 5,
  },
  run() {
    return null;
  },
});

export const invalidKey = defineAction({
  id: "shop.invalidKey",
  rateLimit: {
    key: "session",
    windowMs: 1000,
    max: 5,
  },
  run() {
    return null;
  },
});

export const missingMax = defineAction({
  id: "shop.missingMax",
  rateLimit: {
    key: "player",
    windowMs: 1000,
  },
  run() {
    return null;
  },
});

export const maxZero = defineAction({
  id: "shop.maxZero",
  rateLimit: {
    key: "player",
    windowMs: 1000,
    max: 0,
  },
  run() {
    return null;
  },
});

export const nonIntegerMax = defineAction({
  id: "shop.nonIntegerMax",
  rateLimit: {
    key: "player",
    windowMs: 1000,
    max: 1.5,
  },
  run() {
    return null;
  },
});

export const missingWindowMs = defineAction({
  id: "shop.missingWindowMs",
  rateLimit: {
    key: "player",
    max: 5,
  },
  run() {
    return null;
  },
});

export const windowZero = defineAction({
  id: "shop.windowZero",
  rateLimit: {
    key: "player",
    windowMs: 0,
    max: 5,
  },
  run() {
    return null;
  },
});

export const nonLiteralValue = defineAction({
  id: "shop.nonLiteralValue",
  rateLimit: {
    key: "player",
    windowMs: dynamicWindowMs,
    max: 5,
  },
  run() {
    return null;
  },
});

export const legacyLimit = defineAction({
  id: "shop.legacyLimit",
  rateLimit: {
    key: "player",
    windowMs: 1000,
    max: 5,
    limit: 5,
  },
  run() {
    return null;
  },
});
