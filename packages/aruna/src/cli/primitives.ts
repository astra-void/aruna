// The CLI side of the compiler's primitive registry (crates/aruna_compiler/src/
// primitives). Every place that treats primitives one by one — the contract
// snapshot, parsing a committed snapshot, `aruna contract diff`, and the
// `aruna inspect <primitive>` subcommands — iterates this list instead, so a new
// primitive plugs in with one entry here. See docs/compiler-primitives.md.
//
// Order matters and matches the compiler's registration order: it is the key
// order of the snapshot JSON and the order the inspect subcommands are listed.
import type { CompilerOutput } from "@arunajs/core";
import {
  summarizeActions,
  summarizeSignals,
  summarizeStores,
  type ActionContractSnapshot,
} from "./action-contracts.js";
import {
  diffActions,
  diffSignals,
  diffStores,
  parseActionRecord,
  parseSignalRecord,
  parseStoreRecord,
  storeIdentity,
  type ContractDiffEntry,
} from "./contract-diff.js";
import type { CliColorMode } from "./format.js";
import { buildActionInspectionReport, formatActionInspection } from "./inspect-actions.js";
import { buildSignalInspectionReport, formatSignalInspection } from "./inspect-signals.js";
import { buildStoreInspectionReport, formatStoreInspection } from "./inspect-stores.js";

// How a primitive takes part in the contract snapshot. `TRecord` is its
// snapshot record type.
export type ContractPrimitive<TRecord> = {
  // The snapshot key holding its records.
  readonly key: string;
  // Whether the key is always written. Otherwise it is omitted when empty, so a
  // snapshot from before the primitive existed stays byte-stable and parseable.
  readonly required: boolean;
  // The project's records, in snapshot order.
  readonly summarize: (output: CompilerOutput) => readonly TRecord[];
  // Parses one record of a committed snapshot; throws with `location` in the
  // message when it is malformed.
  readonly parseRecord: (value: unknown, location: string) => TRecord;
  // Two records with the same identity in one snapshot are rejected.
  readonly identity: (record: TRecord) => string;
  readonly duplicateMessage: (location: string, record: TRecord) => string;
  // Appends the changes between two snapshots' records of this primitive.
  readonly diff: (
    before: ActionContractSnapshot,
    after: ActionContractSnapshot,
    entries: ContractDiffEntry[],
  ) => void;
};

// An `aruna inspect <command>` subcommand.
export type InspectPrimitive = {
  readonly command: string;
  readonly description: string;
  readonly report: (output: CompilerOutput) => unknown;
  readonly format: (output: CompilerOutput, colors: CliColorMode) => string;
};

export type PrimitiveRegistration = {
  // The compiler's name for it (`Primitive::NAME`).
  readonly name: string;
  // Present when the compiler marks it `IN_CONTRACT`.
  readonly contract?: ContractPrimitive<{ readonly id: string }>;
  readonly inspect?: InspectPrimitive;
};

// Erases a primitive's record type for the registry list; each entry stays
// checked against its own record type where it is written.
function contract<TRecord extends { readonly id: string }>(
  primitive: ContractPrimitive<TRecord>,
): ContractPrimitive<{ readonly id: string }> {
  return primitive as unknown as ContractPrimitive<{ readonly id: string }>;
}

export const PRIMITIVES: readonly PrimitiveRegistration[] = [
  {
    name: "action",
    contract: contract({
      key: "actions",
      required: true,
      summarize: summarizeActions,
      parseRecord: parseActionRecord,
      identity: (action) => action.id,
      duplicateMessage: (location, action) =>
        `${location} contains a duplicate action id: ${action.id}.`,
      diff: diffActions,
    }),
    inspect: {
      command: "actions",
      description: "show discovered actions and contract metadata",
      report: buildActionInspectionReport,
      format: formatActionInspection,
    },
  },
  {
    name: "signal",
    contract: contract({
      key: "signals",
      required: false,
      summarize: summarizeSignals,
      parseRecord: parseSignalRecord,
      identity: (signal) => signal.id,
      duplicateMessage: (location, signal) =>
        `${location} contains a duplicate signal id: ${signal.id}.`,
      diff: diffSignals,
    }),
    inspect: {
      command: "signals",
      description: "show discovered server-to-client signals",
      report: buildSignalInspectionReport,
      format: formatSignalInspection,
    },
  },
  {
    name: "store",
    contract: contract({
      key: "stores",
      required: false,
      summarize: summarizeStores,
      parseRecord: parseStoreRecord,
      identity: storeIdentity,
      duplicateMessage: (location, store) => `${location} contains a duplicate store: ${store.id}.`,
      diff: diffStores,
    }),
    inspect: {
      command: "stores",
      description: "show discovered stores and their persisted shape",
      report: buildStoreInspectionReport,
      format: formatStoreInspection,
    },
  },
  // Runtimes are in the manifest but not the contract: nothing a client or a
  // saved record depends on changes with them.
  { name: "runtime" },
];

// The registrations that take part in the contract snapshot, in order.
export function contractPrimitives(): ContractPrimitive<{ readonly id: string }>[] {
  return PRIMITIVES.flatMap((primitive) =>
    primitive.contract === undefined ? [] : [primitive.contract],
  );
}
