// Strips `// ...` line comments from JSONC test fixtures (the generated
// tsconfig fragment carries a human-facing header comment). Only full-line
// comments are removed — good enough for Aruna-generated files, which never
// embed `//` inside string values on comment-only lines.
export function stripJsonComments(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}
