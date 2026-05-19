import { defineAction } from "aruna/server";

const dynamicWindowMs = 1000;

export const missingLimit = defineAction({
  id: "shop.missingLimit",
  rateLimit: {
    windowMs: 1000,
  },
  run() {
    return null;
  },
});

export const limitZero = defineAction({
  id: "shop.limitZero",
  rateLimit: {
    limit: 0,
    windowMs: 1000,
  },
  run() {
    return null;
  },
});

export const nonIntegerLimit = defineAction({
  id: "shop.nonIntegerLimit",
  rateLimit: {
    limit: 1.5,
    windowMs: 1000,
  },
  run() {
    return null;
  },
});

export const missingWindowMs = defineAction({
  id: "shop.missingWindowMs",
  rateLimit: {
    limit: 5,
  },
  run() {
    return null;
  },
});

export const windowZero = defineAction({
  id: "shop.windowZero",
  rateLimit: {
    limit: 5,
    windowMs: 0,
  },
  run() {
    return null;
  },
});

export const nonLiteralValue = defineAction({
  id: "shop.nonLiteralValue",
  rateLimit: {
    limit: 5,
    windowMs: dynamicWindowMs,
  },
  run() {
    return null;
  },
});
