export function send(remote: RemoteEvent, amount: number): void {
  remote["FireServer"](amount);
}
