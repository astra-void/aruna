import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type Edit,
  type JSONPath,
  type Node,
} from "jsonc-parser";

// Minimal-diff edits to a JSONC document (the project's tsconfig.json),
// written the way a person would write them: a new key goes on its own line
// under the last one, with that line's indentation and the file's
// trailing-comma style, and an array of plain values stays on one line. No
// other line changes, so comments and the rest of the file's formatting
// survive. jsonc-parser finds where things are, and does the edit itself for a
// layout these rules do not cover — at the cost of reflowing the lines next to
// it.

export type JsoncEditor = {
  // Replaces the value at `jsonPath`, or adds it (creating missing parents).
  readonly set: (jsonPath: JSONPath, value: unknown) => void;
  readonly remove: (jsonPath: JSONPath) => void;
  // Appends `entry` to the array at `jsonPath`, which must exist.
  readonly append: (jsonPath: JSONPath, entry: unknown) => void;
  readonly text: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlain(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

// What may follow the last entry of a multi-line object or array on its line:
// a trailing comma, a comment, whitespace.
const ENTRY_LINE_TAIL = /^[ \t]*(,)?[ \t]*(?:\/\/.*|\/\*.*?\*\/)?[ \t]*$/;

function lineStartOf(text: string, offset: number): number {
  let index = offset;
  while (index > 0 && text[index - 1] !== "\n") {
    index -= 1;
  }
  return index;
}

function lineEndOf(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
    index += 1;
  }
  return index;
}

function lineBreakLengthAt(text: string, offset: number): number {
  if (text.startsWith("\r\n", offset)) {
    return 2;
  }
  return text[offset] === "\n" ? 1 : 0;
}

// The leading whitespace of the line holding `offset`.
function lineIndent(text: string, offset: number): string {
  const start = lineStartOf(text, offset);
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
}

// The whitespace before `offset` on its line, or undefined when something
// else precedes it there.
function ownLineIndent(text: string, offset: number): string | undefined {
  const lead = text.slice(lineStartOf(text, offset), offset);
  return /^[ \t]*$/.test(lead) ? lead : undefined;
}

// The file's indentation unit, read off its first indented line. A file with
// nothing indented yet gets two spaces.
function detectIndentUnit(text: string): string {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent === undefined) {
    return "  ";
  }
  return indent.startsWith("\t") ? "\t" : indent;
}

export function createJsoncEditor(initial: string): JsoncEditor {
  let current = initial;
  const unit = detectIndentUnit(initial);
  const eol = initial.includes("\r\n") ? "\r\n" : "\n";

  // JSON for a value written at `indent`: one key per line for objects, plain
  // arrays inline (`["a", "b"]`), as tsconfig files are usually written.
  const serialize = (value: unknown, indent: string): string => {
    const inner = indent + unit;
    if (Array.isArray(value)) {
      if (value.every(isPlain)) {
        return `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`;
      }
      const entries = value.map((entry) => `${inner}${serialize(entry, inner)}`);
      return `[${eol}${entries.join(`,${eol}`)}${eol}${indent}]`;
    }
    if (isRecord(value)) {
      const entries = Object.entries(value).map(
        ([key, entry]) => `${inner}${JSON.stringify(key)}: ${serialize(entry, inner)}`,
      );
      return entries.length === 0 ? "{}" : `{${eol}${entries.join(`,${eol}`)}${eol}${indent}}`;
    }
    return JSON.stringify(value);
  };

  const apply = (edits: Edit[]): void => {
    current = applyEdits(current, edits);
  };

  const tree = (): Node | undefined => parseTree(current, [], { allowTrailingComma: true });

  // jsonc-parser's own edit, for layouts the rules here do not cover.
  const fallback = (jsonPath: JSONPath, value: unknown, isArrayInsertion = false): void => {
    apply(
      modify(current, jsonPath, value, {
        formattingOptions: {
          insertSpaces: unit !== "\t",
          tabSize: unit === "\t" ? 1 : unit.length,
          eol,
        },
        isArrayInsertion,
      }),
    );
  };

  // Appends an entry (a property, or an array element) to `container`.
  // Returns false for a layout it leaves to jsonc-parser.
  const appendEntry = (container: Node, entryAt: (indent: string) => string): boolean => {
    const children = container.children ?? [];
    const closeOffset = container.offset + container.length - 1;
    if (children.length === 0) {
      if (current.slice(container.offset + 1, closeOffset).trim() !== "") {
        return false;
      }
      if (container.type === "array") {
        apply([
          { offset: container.offset, length: container.length, content: `[${entryAt("")}]` },
        ]);
        return true;
      }
      const outer = lineIndent(current, container.offset);
      const inner = outer + unit;
      apply([
        {
          offset: container.offset,
          length: container.length,
          content: `{${eol}${inner}${entryAt(inner)}${eol}${outer}}`,
        },
      ]);
      return true;
    }

    const last = children[children.length - 1]!;
    const lastEnd = last.offset + last.length;
    const singleLine = !/[\r\n]/.test(current.slice(container.offset, closeOffset));
    if (singleLine && container.type === "array") {
      // `["a", "b"]` -> `["a", "b", "c"]`.
      if (!/^\s*,?\s*$/.test(current.slice(lastEnd, closeOffset))) {
        return false;
      }
      apply([{ offset: lastEnd, length: 0, content: `, ${entryAt("")}` }]);
      return true;
    }
    if (singleLine) {
      // `{ "@/*": ["./src/*"] }` opens up to one key per line, each existing
      // entry kept as written. Anything but commas between the entries (a
      // comment) is left to jsonc-parser.
      let between = current.slice(container.offset + 1, closeOffset);
      for (const child of [...children].reverse()) {
        const start = child.offset - container.offset - 1;
        between = between.slice(0, start) + between.slice(start + child.length);
      }
      if (!/^[\s,]*$/.test(between)) {
        return false;
      }
      const outer = lineIndent(current, container.offset);
      const inner = outer + unit;
      const entries = [
        ...children.map((child) => current.slice(child.offset, child.offset + child.length)),
        entryAt(inner),
      ];
      apply([
        {
          offset: container.offset,
          length: container.length,
          content: `{${eol}${entries.map((entry) => `${inner}${entry}`).join(`,${eol}`)}${eol}${outer}}`,
        },
      ]);
      return true;
    }

    const indent = ownLineIndent(current, last.offset);
    const lineEnd = lineEndOf(current, lastEnd);
    const tail = ENTRY_LINE_TAIL.exec(current.slice(lastEnd, lineEnd));
    if (indent === undefined || tail === null) {
      return false;
    }
    const entry = `${eol}${indent}${entryAt(indent)}`;
    if (tail[1] !== undefined) {
      apply([{ offset: lineEnd, length: 0, content: `${entry},` }]);
    } else if (lineEnd === lastEnd) {
      // One edit: two insertions at the same offset would apply in the wrong order.
      apply([{ offset: lastEnd, length: 0, content: `,${entry}` }]);
    } else {
      // A comment follows the last entry on its line; the comma goes before it.
      apply([
        { offset: lastEnd, length: 0, content: "," },
        { offset: lineEnd, length: 0, content: entry },
      ]);
    }
    return true;
  };

  return {
    set(jsonPath, value) {
      const root = tree();
      if (root === undefined) {
        fallback(jsonPath, value);
        return;
      }
      const existing = findNodeAtLocation(root, jsonPath);
      if (existing !== undefined) {
        const anchor = existing.parent?.type === "property" ? existing.parent : existing;
        apply([
          {
            offset: existing.offset,
            length: existing.length,
            content: serialize(value, lineIndent(current, anchor.offset)),
          },
        ]);
        return;
      }
      // Missing parents become part of the inserted value.
      let depth = jsonPath.length - 1;
      let inserted = value;
      let parent = findNodeAtLocation(root, jsonPath.slice(0, depth));
      while (parent === undefined && depth > 0) {
        inserted = { [String(jsonPath[depth])]: inserted };
        depth -= 1;
        parent = findNodeAtLocation(root, jsonPath.slice(0, depth));
      }
      const key = jsonPath[depth];
      const added =
        parent?.type === "object" &&
        typeof key === "string" &&
        appendEntry(parent, (indent) => `${JSON.stringify(key)}: ${serialize(inserted, indent)}`);
      if (!added) {
        fallback(jsonPath, value);
      }
    },

    remove(jsonPath) {
      const root = tree();
      const existing = root && findNodeAtLocation(root, jsonPath);
      const property = existing?.parent;
      const container = property?.parent;
      if (existing === undefined || property?.type !== "property" || container === undefined) {
        if (existing !== undefined) {
          fallback(jsonPath, undefined);
        }
        return;
      }
      const siblings = container.children ?? [];
      const index = siblings.indexOf(property);
      const start = property.offset;
      const end = property.offset + property.length;
      const lineEnd = lineEndOf(current, end);
      const tail = ENTRY_LINE_TAIL.exec(current.slice(end, lineEnd));
      if (siblings.length < 2 || ownLineIndent(current, start) === undefined || tail === null) {
        fallback(jsonPath, undefined);
        return;
      }
      // The property sits on lines of its own: drop those lines whole.
      const removal: Edit = {
        offset: lineStartOf(current, start),
        length: lineEnd + lineBreakLengthAt(current, lineEnd) - lineStartOf(current, start),
        content: "",
      };
      if (index === siblings.length - 1 && tail[1] === undefined) {
        // The last entry, written without a trailing comma: the one before it
        // becomes last and gives up its comma.
        const previous = siblings[index - 1]!;
        const comma = current.indexOf(",", previous.offset + previous.length);
        if (comma === -1 || comma >= removal.offset) {
          fallback(jsonPath, undefined);
          return;
        }
        apply([removal, { offset: comma, length: 1, content: "" }]);
        return;
      }
      apply([removal]);
    },

    append(jsonPath, entry) {
      const root = tree();
      const array = root && findNodeAtLocation(root, jsonPath);
      if (array?.type !== "array" || !appendEntry(array, (indent) => serialize(entry, indent))) {
        fallback([...jsonPath, -1], entry, true);
      }
    },

    text: () => current,
  };
}
