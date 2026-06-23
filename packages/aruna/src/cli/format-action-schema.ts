import type { SchemaLiteralMetadata, SchemaMetadata } from "@arunajs/core";

export type ActionSchemaSummary = {
  readonly summary: string;
  readonly warnings: readonly string[];
};

function isValidIdentifier(text: string): boolean {
  const first = text[0];
  if (!first || !(first === "_" || first === "$" || /[A-Za-z]/.test(first))) {
    return false;
  }

  for (const character of text.slice(1)) {
    if (!(character === "_" || character === "$" || /[A-Za-z0-9]/.test(character))) {
      return false;
    }
  }

  return true;
}

function renderPropertyKey(key: string): string {
  return isValidIdentifier(key) ? key : JSON.stringify(key);
}

function renderLiteralMetadata(literal: SchemaLiteralMetadata): string {
  switch (literal.kind) {
    case "string":
      return JSON.stringify(literal.value);
    case "number":
      return literal.value;
    case "boolean":
      return String(literal.value);
    case "undefined":
      return "undefined";
  }
}

function wrapTypeForArray(summary: string): string {
  if (summary.includes(" | ") || summary.startsWith("object ")) {
    return `(${summary})`;
  }

  return summary;
}

function sortWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)].sort((left, right) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function summarizeSchema(schema: SchemaMetadata | undefined): ActionSchemaSummary {
  if (!schema) {
    return {
      summary: "unknown (metadata unavailable)",
      warnings: [],
    };
  }

  switch (schema.kind) {
    case "string":
      return { summary: "string", warnings: [] };
    case "number":
      // Surface the numeric width hint so `inspect actions` and `contract diff`
      // distinguish a u8 from a u16. Plain schema.number() carries no format.
      return { summary: schema.numericFormat ?? "number", warnings: [] };
    case "boolean":
      return { summary: "boolean", warnings: [] };
    case "literal":
      return {
        summary: schema.literal
          ? renderLiteralMetadata(schema.literal)
          : "unknown (metadata unavailable)",
        warnings: schema.literal ? [] : ["literal metadata missing"],
      };
    case "array": {
      if (!schema.items) {
        return {
          summary: "unknown (metadata unavailable)",
          warnings: ["array item metadata missing"],
        };
      }

      const item = summarizeSchema(schema.items);
      return {
        summary: `${wrapTypeForArray(item.summary)}[]`,
        warnings: item.warnings,
      };
    }
    case "object": {
      if (!schema.properties) {
        return {
          summary: "unknown (metadata unavailable)",
          warnings: ["object property metadata missing"],
        };
      }

      const rendered: string[] = [];
      const warnings: string[] = [];
      const entries = Object.entries(schema.properties).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );

      for (const [key, value] of entries) {
        if (value.kind === "optional") {
          if (!value.inner) {
            rendered.push(`${renderPropertyKey(key)}?: unknown (metadata unavailable)`);
            warnings.push("optional field metadata missing");
            continue;
          }

          const inner = summarizeSchema(value.inner);
          rendered.push(`${renderPropertyKey(key)}?: ${inner.summary}`);
          warnings.push(...inner.warnings);
          continue;
        }

        const child = summarizeSchema(value);
        rendered.push(`${renderPropertyKey(key)}: ${child.summary}`);
        warnings.push(...child.warnings);
      }

      return {
        summary: rendered.length === 0 ? "object {}" : `object { ${rendered.join(", ")} }`,
        warnings,
      };
    }
    case "optional": {
      if (!schema.inner) {
        return {
          summary: "unknown (metadata unavailable)",
          warnings: ["optional metadata missing"],
        };
      }

      const inner = summarizeSchema(schema.inner);
      return {
        summary: `${inner.summary} | undefined`,
        warnings: inner.warnings,
      };
    }
    case "enum": {
      if (!schema.values) {
        return {
          summary: "unknown (metadata unavailable)",
          warnings: ["enum value metadata missing"],
        };
      }

      if (schema.values.length === 0) {
        return { summary: "never", warnings: [] };
      }

      return {
        summary: schema.values.map(renderLiteralMetadata).join(" | "),
        warnings: [],
      };
    }
    default:
      return {
        summary: "unknown (metadata unavailable)",
        warnings: [`unsupported schema metadata: ${schema.kind}`],
      };
  }
}

export function formatActionSchemaSummary(
  schema: SchemaMetadata | undefined,
): ActionSchemaSummary {
  const summary = summarizeSchema(schema);
  return {
    summary: summary.summary,
    warnings: sortWarnings(summary.warnings),
  };
}
