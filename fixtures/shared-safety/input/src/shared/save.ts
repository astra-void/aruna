const RunService = game.GetService("RunService");
const DataStoreService = game.GetService("DataStoreService");

export function openStore() {
  return game.GetService("MemoryStoreService");
}

export function serverOnly() {
  if (RunService.IsClient()) {
    return undefined;
  }
  return game.GetService("ServerStorage");
}

export const stores = DataStoreService;
