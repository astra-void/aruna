// The store compatibility gate behind `aruna check` and `aruna build`.
//
// In Roblox, a client is replicated from the server it joined, so client and
// server code inside one server always match. The boundary that does cross
// versions is persisted data: records a previous build wrote stay in the
// DataStore, and this build has to read them. When the project commits a
// contract snapshot (`contract.snapshot`, default `aruna.contract.json`), every
// check and build compares the stores against it, and a change that would leave
// saved records unreadable fails the build (aruna::578) instead of surfacing as
// load failures in production. `aruna contract update` rewrites the snapshot,
// and refuses to record a change like that: intending it does not make the old
// records readable.
import fs from "node:fs/promises";
import path from "node:path";
import type { CompilerOutput, Diagnostic } from "@arunajs/core";
import { buildActionContractSnapshot, type ActionContractSnapshot } from "./action-contracts.js";
import {
  diffActionContractSnapshots,
  parseActionContractSnapshotJson,
  type ContractDiffEntry,
} from "./contract-diff.js";

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
          "Restore the file from version control. `aruna contract update --accept-unreadable-records` overwrites it without comparing, which skips the store check this once.",
      },
    ];
  }

  if (isIgnored(output, STORE_INCOMPATIBLE_CHANGE_CODE, "store-incompatible-change")) {
    return [];
  }

  const current = buildActionContractSnapshot(output);
  const sourceOf = new Map((current.stores ?? []).map((store) => [store.id, store.source]));

  return unreadableRecordChanges(committed.snapshot, current).map((entry): Diagnostic => {
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
          "Keep saved records readable: give the new field a .default(...), or bump the store's version and add a migrate() that converts the old records.",
      };
    });
}

// The store changes between two snapshots that would leave a record the older
// one saved unreadable by the newer one.
export function unreadableRecordChanges(
  before: ActionContractSnapshot,
  after: ActionContractSnapshot,
): ContractDiffEntry[] {
  return diffActionContractSnapshots(before, after).entries.filter(
    (entry) => entry.severity === "breaking" && entry.kind.startsWith("store-"),
  );
}

function serializeSnapshot(snapshot: ActionContractSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export type ContractUpdatePlan = {
  readonly snapshotPath: string;
  readonly snapshot: ActionContractSnapshot;
  // False when the committed file already records this snapshot.
  readonly outOfDate: boolean;
  // How the committed file was read: absent, unreadable, or compared.
  readonly committed: "missing" | "invalid" | "ok";
  readonly invalidMessage?: string;
  // Store changes since the committed snapshot that leave saved records
  // unreadable. Empty unless `committed` is "ok".
  readonly unreadable: readonly ContractDiffEntry[];
};

// What `aruna contract update` would do: the snapshot it would write, whether
// that differs from the committed one, and what it would accept by writing it.
// Whitespace in the committed file does not make it out of date.
export async function planContractUpdate(output: CompilerOutput): Promise<ContractUpdatePlan> {
  const { absolute, relative } = contractSnapshotPath(output);
  const snapshot = buildActionContractSnapshot(output);
  const committed = await readCommittedSnapshot(output);
  if (committed.kind === "missing") {
    return { snapshotPath: relative, snapshot, outOfDate: true, committed: "missing", unreadable: [] };
  }
  if (committed.kind === "invalid") {
    return {
      snapshotPath: relative,
      snapshot,
      outOfDate: true,
      committed: "invalid",
      invalidMessage: committed.message,
      unreadable: [],
    };
  }
  // The parsed snapshot normalizes what it reads, so the raw file is what is
  // compared: a field the parser drops still makes the file out of date.
  const raw = await fs.readFile(absolute, "utf8");
  return {
    snapshotPath: relative,
    snapshot,
    outOfDate: JSON.stringify(JSON.parse(raw)) !== JSON.stringify(snapshot),
    committed: "ok",
    unreadable: unreadableRecordChanges(committed.snapshot, snapshot),
  };
}

// Writes the current contract to the configured snapshot path. The snapshot is
// the project's record of what it last shipped, so it is written only from a
// project that compiles cleanly.
export async function writeContractSnapshot(
  output: CompilerOutput,
  snapshot: ActionContractSnapshot = buildActionContractSnapshot(output),
): Promise<string> {
  const { absolute, relative } = contractSnapshotPath(output);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, serializeSnapshot(snapshot), "utf8");
  return relative;
}
