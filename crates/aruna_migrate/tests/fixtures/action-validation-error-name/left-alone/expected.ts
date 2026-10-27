// Mentions of SchemaValidationError in comments stay as they are.
export const VALIDATION_ERROR = "SchemaValidationError";

export function log(error: { name: string; message: string }, kind: string): void {
  print(`saw a SchemaValidationError: ${error.message}`);
  print("SchemaValidationError happened");
  if (kind === "SchemaValidationError") {
    print("compared against something that is not a name");
  }
  if (error.name === "ActionValidationError") {
    print("already migrated");
  }
  if (error.message === "SchemaValidationError") {
    print("a message, not a name");
  }
}
