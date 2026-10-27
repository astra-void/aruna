// The store compatibility gate behind `aruna check` and `aruna build`.
//
// In Roblox, a client is replicated from the server it joined, so client and
// server code inside one server always match. The boundary that does cross
// versions is persisted data: records a previous build wrote stay in the
// DataStore, and this build has to read them. When the project commits a
// contract snapshot (`contract.snapshot`, default `aruna.contract.json`), every
// check and build compares the stores against it, and a change that would leave
// saved records unreadable fails the build (aruna::578) instead of surfacing as
// load failures in production. `aruna contract update` rewrites the snapshot
// once a change is intended.
import fs from "node:fs/promises";
import path from "node:path";
import type { CompilerOutput, Diagnostic } from "@arunajs/core";
import { buildActionContractSnapshot, type ActionContractSnapshot } from "./action-contracts.js";
import { diffActionContractSnapshots, parseActionContractSnapshotJson } from "./contract-diff.js";

export const STORE_INCOMPATIBLE_CHANGE_CODE = "aruna::578";
export const CONTRACT_SNAPSHOT_INVALID_CODE = "aruna::579";

function toPosix(text: string): string {
  return text.split(path.sep).join("/");
}

// The configured snapshot path, absolute and relative to the project root.
export function contractSnapshotPath(output: CompilerOutput): {
  readonly absolute: string;
  readonly relative: string;
} {
  const relative = output.config.contract?.snapshot ?? "aruna.contract.json";
  return { absolute: path.resolve(output.projectRoot, relative), relative: toPosix(relative) };
}

// Reads the committed snapshot. `missing` when there is none, which turns the
// gate off.
export async function readCommittedSnapshot(
  output: CompilerOutput,
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "ok"; readonly snapshot: ActionContractSnapshot }
> {
  const { absolute } = contractSnapshotPath(output);
  let contents: string;
  try {
    contents = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { kind: "ok", snapshot: parseActionContractSnapshotJson(JSON.parse(contents)) };
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

function isIgnored(output: CompilerOutput, code: string, name: string): boolean {
  const ignore = output.config.diagnostics?.ignore ?? [];
  return ignore.includes(code) || ignore.includes(name);
}

// Compares the project's stores against the committed snapshot. Empty when
// there is no snapshot, the gate is off, or nothing incompatible changed.
export async function collectContractGateDiagnostics(
  output: CompilerOutput,
): Promise<Diagnostic[]> {
  const severity = output.config.strict?.storeCompatibility ?? "error";
  if (severity === "off") {
    return [];
  }

  const committed = await readCommittedSnapshot(output);
  if (committed.kind === "missing") {
    return [];
  }

  const { relative } = contractSnapshotPath(output);
  if (committed.kind === "invalid") {
    if (isIgnored(output, CONTRACT_SNAPSHOT_INVALID_CODE, "contract-snapshot-invalid")) {
      return [];
    }
    return [
      {
        code: CONTRACT_SNAPSHOT_INVALID_CODE,
        name: "contract-snapshot-invalid",
        severity: "error",
        message: `The committed contract snapshot ${relative} could not be read: ${committed.message}`,
        file: relative,
        suggestion:
          "Fix the file, or regenerate it from the current code with `aruna contract update`.",
      },
    ];
  }

  if (isIgnored(output, STORE_INCOMPATIBLE_CHANGE_CODE, "store-incompatible-change")) {
    return [];
  }

  const current = buildActionContractSnapshot(output);
  const result = diffActionContractSnapshots(committed.snapshot, current);
  const sourceOf = new Map((current.stores ?? []).map((store) => [store.id, store.source]));

  return result.entries
    .filter((entry) => entry.severity === "breaking" && entry.kind.startsWith("store-"))
    .map((entry): Diagnostic => {
      const storeId = entry.actionId ?? "";
      const detailLines = [
        `compared against ${relative}`,
        ...(entry.before !== undefined ? [`before: ${JSON.stringify(entry.before)}`] : []),
        ...(entry.after !== undefined ? [`after: ${JSON.stringify(entry.after)}`] : []),
      ];
      return {
        code: STORE_INCOMPATIBLE_CHANGE_CODE,
        name: "store-incompatible-change",
        severity,
        message: entry.message,
        file: sourceOf.get(storeId) ?? relative,
        details: detailLines.join("\n"),
        suggestion:
          "Keep saved records readable: give a new field a .default(...), or bump the store's version and add a migrate(). Once the change is intended, run `aruna contract update`.",
      };
    });
}

// Writes the current contract to the configured snapshot path. The snapshot is
// the project's record of what it last shipped, so it is written only from a
// project that compiles cleanly.
export async function writeContractSnapshot(output: CompilerOutput): Promise<string> {
  const { absolute, relative } = contractSnapshotPath(output);
  const snapshot = buildActionContractSnapshot(output);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return relative;
}
