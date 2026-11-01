// Server-only wallet state. A real game keeps this in a player store; the
// resource reads it either way, and only through `load`.
const coins = new Map<number, number>();

export function coinsOf(userId: number): number {
  return coins.get(userId) ?? 0;
}

export function addCoins(userId: number, amount: number): number {
  const total = coinsOf(userId) + amount;
  coins.set(userId, total);
  return total;
}
