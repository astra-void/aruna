export function describeFailure(error: { name: string }): string {
  switch (error.name) {
    case "SchemaValidationError":
      return "the request did not match the action's schema";
    case "ActionRateLimitError":
      return "slow down";
    default:
      return "something else";
  }
}

export function byKind(kind: string): number {
  // Not an error's name: reported, not rewritten.
  switch (kind) {
    case "SchemaValidationError":
      return 1;
    default:
      return 0;
  }
}
