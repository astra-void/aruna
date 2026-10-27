// A hand-made remote: traffic over it skips action validation and rate limiting.
export const remote = new Instance("RemoteEvent");

remote.OnServerEvent.Connect((player, amount) => {
  remote.FireAllClients(player, amount);
});
