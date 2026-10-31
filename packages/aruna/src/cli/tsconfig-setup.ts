import fs from "node:fs";
import path from "node:path";
import { parse, printParseErrorCode, type JSONPath, type ParseError } from "jsonc-parser";
import { createJsoncEditor } from "./jsonc-edit.js";
import {
  RETIRED_TSCONFIG_FRAGMENT_FILE,
  arunaAliasTargets,
  isArunaOwnedAlias,
} from "./tsconfig-paths.js";

// ---------------------------------------------------------------------------
// tsconfig.json upkeep
//
// Aruna keeps the project's tsconfig.json correct by itself, the way Next.js
// does for its projects: `aruna init`, `build`, `dev`, `test`, and
// `doctor --fix` read the file, work out what roblox-ts and Aruna need from
// it, and edit only those keys in place, so comments, formatting, and every
// other key survive. A value roblox-ts cannot work without is forced (a
// mandatory change); a value that is only a sensible default is added when the
// project leaves the key unset, and is the project's to change afterwards (a
// suggested value). Whatever a base config supplies through `extends` counts
// as set, so a project that keeps its settings in a shared base is left alone.
//
// Nothing here writes a `baseUrl`: path aliases are written relative to the
// file (with a leading "./", which TypeScript requires without one), and a
// project that chose its own baseUrl keeps it.
// ---------------------------------------------------------------------------

export type TsconfigChange = {
  // The tsconfig key the change is about: "module", "paths", "include", ...
  readonly key: string;
  // What happens to the key, worded to follow "was" (or "would be"):
  // `set to "CommonJS"`, `updated to add src/.aruna/**/*.ts`.
  readonly change: string;
  // Why a mandatory change is mandatory; suggested values have none.
  readonly reason?: string | undefined;
};

// Where an Aruna alias stands in the tsconfig as it is now.
export type TsconfigAliasStatus = {
  readonly alias: string;
  // The target the upkeep writes, as it would appear in tsconfig.json.
  readonly expected: string;
  readonly actual?: string | undefined;
  // Project-relative path of the base config that maps the alias, when it is
  // inherited through `extends` (`actual` is then relative to that file).
  readonly declaredIn?: string | undefined;
  // "stale": mapped, but to a file other than the one Aruna generates.
  readonly status: "ok" | "missing" | "stale";
};

export type TsconfigSetup =
  | {
      readonly status: "unreadable";
      readonly tsconfigPath: string;
      readonly error: string;
    }
  | {
      // "create": there is no tsconfig.json yet. "update": the file lacks some
      // of the changes below. "ok": nothing to change.
      readonly status: "create" | "update" | "ok";
      readonly tsconfigPath: string;
      // The file as it should read (what is on disk already, for "ok").
      readonly contents: string;
      readonly mandatory: readonly TsconfigChange[];
      readonly suggested: readonly TsconfigChange[];
      readonly aliases: readonly TsconfigAliasStatus[];
      // Project-relative path of the retired generated fragment, when the
      // tsconfig still extends it. The upkeep drops the reference.
      readonly retiredFragment?: string | undefined;
    };

const REQUIRED_BY_ROBLOX_TS = "required by roblox-ts";

type MandatoryOption = {
  readonly key: string;
  readonly value: unknown;
  readonly reason: string;
  // Whether the value the project resolves to already works. Enum-like
  // options compare case-insensitively, as TypeScript reads them.
  readonly accepts: (value: unknown) => boolean;
};

function oneOf(...names: readonly string[]): (value: unknown) => boolean {
  return (value) => typeof value === "string" && names.includes(value.toLowerCase());
}

// The compile contract roblox-ts enforces (its validateCompilerOptions). The
// staged compile `aruna build` runs uses it whatever the project says, so the
// editor and `tsc` check against the contract the build compiles with.
const MANDATORY_COMPILER_OPTIONS: readonly MandatoryOption[] = [
  { key: "target", value: "ESNext", reason: REQUIRED_BY_ROBLOX_TS, accepts: oneOf("esnext") },
  { key: "module", value: "CommonJS", reason: REQUIRED_BY_ROBLOX_TS, accepts: oneOf("commonjs") },
  {
    key: "moduleResolution",
    value: "Node",
    reason: REQUIRED_BY_ROBLOX_TS,
    accepts: oneOf("node", "node10"),
  },
  {
    key: "moduleDetection",
    value: "force",
    reason: REQUIRED_BY_ROBLOX_TS,
    accepts: oneOf("force"),
  },
  {
    key: "noLib",
    value: true,
    reason: "Roblox has no JavaScript standard library",
    accepts: (value) => value === true,
  },
  { key: "strict", value: true, reason: REQUIRED_BY_ROBLOX_TS, accepts: (value) => value === true },
  {
    key: "allowSyntheticDefaultImports",
    value: true,
    reason: REQUIRED_BY_ROBLOX_TS,
    accepts: (value) => value === true,
  },
  // Under the CommonJS module roblox-ts requires, verbatimModuleSyntax makes
  // every `import` an error, so only an explicit `true` is replaced.
  {
    key: "verbatimModuleSyntax",
    value: false,
    reason: "it rejects every import under CommonJS",
    accepts: (value) => value !== true,
  },
];

type SuggestedOption = {
  readonly key: string;
  readonly value: unknown;
  // Another key that, when set, leaves this one nothing to do.
  readonly satisfiedBy?: string | undefined;
};

const SUGGESTED_COMPILER_OPTIONS: readonly SuggestedOption[] = [
  // @rbxts/types ships ambient declarations that only typecheck under the
  // exact compiler-types they were generated against; skipLibCheck keeps a
  // point release of the types package from breaking consumer typechecks.
  { key: "skipLibCheck", value: true },
  // roblox-ts requires a rootDir (or rootDirs) and an outDir to be set; which
  // ones is the project's call. `aruna build` compiles src -> out either way.
  { key: "rootDir", value: "src", satisfiedBy: "rootDirs" },
  { key: "outDir", value: "out" },
  { key: "jsx", value: "preserve" },
  { key: "downlevelIteration", value: true },
  { key: "esModuleInterop", value: true },
  { key: "forceConsistentCasingInFileNames", value: true },
  { key: "resolveJsonModule", value: true },
  { key: "noUncheckedIndexedAccess", value: true },
];

const DEFAULT_TYPE_ROOTS = ["./node_modules", "./node_modules/@rbxts"];
const DEFAULT_TYPES = ["@rbxts/types", "@rbxts/compiler-types"];
const DEFAULT_EXCLUDE = ["aruna.config.ts", "out", "node_modules"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

// A path written into tsconfig.json: posix and relative to `fromDir`, with a
// leading "./" — TypeScript rejects a non-relative `paths` target when there
// is no baseUrl.
function relativeSpecifier(fromDir: string, target: string): string {
  const relative = toPosix(path.relative(fromDir, target));
  return relative === ".." || relative.startsWith("../") ? relative : `./${relative}`;
}

// An include/exclude entry, written the way they usually are: no leading "./".
function relativeGlob(fromDir: string, target: string): string {
  return toPosix(path.relative(fromDir, target)) || ".";
}

function isInsideOrEqual(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatValue(value: unknown): string {
  return Array.isArray(value)
    ? `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`
    : JSON.stringify(value);
}

function parseJsonc(text: string): { value?: Record<string, unknown>; error?: string } {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first !== undefined) {
    const line = text.slice(0, first.offset).split("\n").length;
    return { error: `invalid JSON (${printParseErrorCode(first.error)} on line ${line})` };
  }
  if (!isRecord(value)) {
    return { error: "the top-level JSON value must be an object" };
  }
  return { value };
}

function readJsoncObject(file: string): Record<string, unknown> | undefined {
  try {
    return parseJsonc(fs.readFileSync(file, "utf8")).value;
  } catch {
    return undefined;
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function extendsRefs(config: Record<string, unknown>): string[] {
  const value = config["extends"];
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isRelativeRef(ref: string): boolean {
  return ref.startsWith("./") || ref.startsWith("../") || path.isAbsolute(ref);
}

// Where an `extends` entry points, as TypeScript looks it up: a relative path
// (with ".json" implied), or a package config found in node_modules.
function resolveExtendsTarget(ref: string, fromDir: string): string | undefined {
  const candidates: string[] = [];
  if (isRelativeRef(ref)) {
    const base = path.resolve(fromDir, ref);
    candidates.push(base, `${base}.json`);
  } else {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      const base = path.join(dir, "node_modules", ref);
      candidates.push(base, `${base}.json`, path.join(base, "tsconfig.json"));
      if (path.dirname(dir) === dir) {
        break;
      }
    }
  }
  return candidates.find(isFile);
}

// A setting and the config file that supplied it. TypeScript resolves a
// path-valued setting (baseUrl, typeRoots, paths, include) against the
// directory of that file, not the project's.
type Supplied = {
  readonly value: unknown;
  readonly file: string;
  // Set in tsconfig.json itself rather than inherited through `extends`.
  readonly own: boolean;
};

type Settings = {
  readonly compilerOptions: Map<string, Supplied>;
  readonly topLevel: Map<string, Supplied>;
};

const INHERITED_TOP_LEVEL_KEYS = ["include", "exclude", "files"] as const;

// What `config`'s `extends` chain supplies, nearest config winning per key and
// a later `extends` entry winning over an earlier one, as in TypeScript.
function inheritedSettings(
  config: Record<string, unknown>,
  configFile: string,
  visiting: ReadonlySet<string>,
): Settings {
  const settings: Settings = { compilerOptions: new Map(), topLevel: new Map() };
  for (const ref of extendsRefs(config)) {
    const target = resolveExtendsTarget(ref, path.dirname(configFile));
    if (target === undefined || visiting.has(target)) {
      continue;
    }
    const base = readJsoncObject(target);
    if (base === undefined) {
      continue;
    }
    const fromBase = inheritedSettings(base, target, new Set([...visiting, target]));
    const own = isRecord(base["compilerOptions"]) ? base["compilerOptions"] : {};
    for (const [key, value] of Object.entries(own)) {
      fromBase.compilerOptions.set(key, { value, file: target, own: false });
    }
    for (const key of INHERITED_TOP_LEVEL_KEYS) {
      if (base[key] !== undefined) {
        fromBase.topLevel.set(key, { value: base[key], file: target, own: false });
      }
    }
    for (const [key, supplied] of fromBase.compilerOptions) {
      settings.compilerOptions.set(key, supplied);
    }
    for (const [key, supplied] of fromBase.topLevel) {
      settings.topLevel.set(key, supplied);
    }
  }
  return settings;
}

// A shape tsconfig.json must have before the upkeep can edit it. Anything else
// is left for the project to fix; TypeScript rejects it anyway.
function shapeProblem(config: Record<string, unknown>): string | undefined {
  const extendsValue = config["extends"];
  if (
    extendsValue !== undefined &&
    typeof extendsValue !== "string" &&
    !(Array.isArray(extendsValue) && extendsValue.every((entry) => typeof entry === "string"))
  ) {
    return "extends must be a string or an array of strings";
  }
  for (const key of ["include", "exclude"]) {
    if (config[key] !== undefined && !Array.isArray(config[key])) {
      return `${key} must be an array`;
    }
  }
  const compilerOptions = config["compilerOptions"];
  if (compilerOptions === undefined) {
    return undefined;
  }
  if (!isRecord(compilerOptions)) {
    return "compilerOptions must be an object";
  }
  if (compilerOptions["paths"] !== undefined && !isRecord(compilerOptions["paths"])) {
    return "compilerOptions.paths must be an object";
  }
  if (compilerOptions["typeRoots"] !== undefined && !Array.isArray(compilerOptions["typeRoots"])) {
    return "compilerOptions.typeRoots must be an array";
  }
  return undefined;
}

export type TsconfigSetupOptions = {
  readonly projectRoot: string;
  readonly generatedDir: string;
};

// Works out what tsconfig.json needs, without writing anything. `aruna check`
// and `aruna doctor` report from this; applyTsconfigSetup writes it.
export function planTsconfigSetup(options: TsconfigSetupOptions): TsconfigSetup {
  const projectRoot = path.resolve(options.projectRoot);
  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  const tsconfigDir = projectRoot;

  let existing: string | undefined;
  try {
    existing = fs.readFileSync(tsconfigPath, "utf8");
  } catch {
    existing = undefined;
  }

  const parsed = parseJsonc(existing ?? "{}\n");
  if (parsed.value === undefined) {
    return { status: "unreadable", tsconfigPath, error: parsed.error ?? "unreadable" };
  }
  const problem = shapeProblem(parsed.value);
  if (problem !== undefined) {
    return { status: "unreadable", tsconfigPath, error: problem };
  }

  const editor = createJsoncEditor(existing ?? "{}\n");
  const mandatory: TsconfigChange[] = [];
  const suggested: TsconfigChange[] = [];
  let config = parsed.value;

  // A tsconfig from before Aruna wrote its settings here extends the fragment
  // older builds generated. The build no longer writes (and prunes) that
  // file, so the reference goes, and everything the fragment supplied is
  // written below as if it had never been there.
  const retiredFragmentPath = path.resolve(
    projectRoot,
    options.generatedDir,
    RETIRED_TSCONFIG_FRAGMENT_FILE,
  );
  const refs = extendsRefs(config);
  const keptRefs = refs.filter((ref) => {
    if (!isRelativeRef(ref)) {
      return true;
    }
    const resolved = path.resolve(tsconfigDir, ref);
    return resolved !== retiredFragmentPath && `${resolved}.json` !== retiredFragmentPath;
  });
  const retiredFragment =
    keptRefs.length < refs.length ? relativeGlob(projectRoot, retiredFragmentPath) : undefined;
  if (retiredFragment !== undefined) {
    if (keptRefs.length === 0) {
      editor.remove(["extends"]);
    } else {
      editor.set(["extends"], keptRefs.length === 1 ? keptRefs[0] : keptRefs);
    }
    mandatory.push({
      key: "extends",
      change: `updated to drop ./${retiredFragment}`,
      reason: "Aruna writes its settings into tsconfig.json itself now",
    });
    config = parseJsonc(editor.text()).value ?? config;
  }

  const inherited = inheritedSettings(config, tsconfigPath, new Set([tsconfigPath]));
  const ownOptions = isRecord(config["compilerOptions"]) ? config["compilerOptions"] : {};
  const option = (key: string): Supplied | undefined =>
    key in ownOptions
      ? { value: ownOptions[key], file: tsconfigPath, own: true }
      : inherited.compilerOptions.get(key);
  const topLevel = (key: string): Supplied | undefined =>
    config[key] !== undefined
      ? { value: config[key], file: tsconfigPath, own: true }
      : inherited.topLevel.get(key);

  // Adds `entry` to an array-valued setting. An inherited array is copied in
  // first, rebased onto tsconfig.json's directory: setting the key here
  // replaces what the base config supplied.
  const appendEntry = (jsonPath: JSONPath, supplied: Supplied, entry: string): void => {
    if (supplied.own) {
      editor.append(jsonPath, entry);
      return;
    }
    const fromDir = path.dirname(supplied.file);
    const copied = (supplied.value as unknown[]).map((value) =>
      typeof value === "string" ? relativeGlob(tsconfigDir, path.resolve(fromDir, value)) : value,
    );
    editor.set(jsonPath, [...copied, entry]);
  };

  for (const desired of MANDATORY_COMPILER_OPTIONS) {
    if (!desired.accepts(option(desired.key)?.value)) {
      editor.set(["compilerOptions", desired.key], desired.value);
      mandatory.push({
        key: desired.key,
        change: `set to ${formatValue(desired.value)}`,
        reason: desired.reason,
      });
    }
  }

  // roblox-ts loads the @rbxts packages' types through typeRoots and refuses a
  // config whose typeRoots miss node_modules/@rbxts.
  const typeRoots = option("typeRoots");
  const rbxtsTypeRoot = path.join(projectRoot, "node_modules", "@rbxts");
  let typeRootDirs: string[];
  if (typeRoots === undefined || !Array.isArray(typeRoots.value)) {
    editor.set(["compilerOptions", "typeRoots"], DEFAULT_TYPE_ROOTS);
    mandatory.push({
      key: "typeRoots",
      change: `set to ${formatValue(DEFAULT_TYPE_ROOTS)}`,
      reason: REQUIRED_BY_ROBLOX_TS,
    });
    typeRootDirs = DEFAULT_TYPE_ROOTS.map((entry) => path.resolve(tsconfigDir, entry));
  } else {
    const fromDir = path.dirname(typeRoots.file);
    typeRootDirs = typeRoots.value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => path.resolve(fromDir, entry));
    if (!typeRootDirs.includes(rbxtsTypeRoot)) {
      appendEntry(["compilerOptions", "typeRoots"], typeRoots, "./node_modules/@rbxts");
      mandatory.push({
        key: "typeRoots",
        change: "updated to add ./node_modules/@rbxts",
        reason: REQUIRED_BY_ROBLOX_TS,
      });
      typeRootDirs.push(rbxtsTypeRoot);
    }
  }

  // With node_modules itself a type root, every installed package would load
  // as a types package; naming the two roblox-ts needs keeps it to those. A
  // project on the classic `node_modules/@rbxts` type root loads its @rbxts
  // packages automatically and needs no list.
  if (
    option("types") === undefined &&
    typeRootDirs.includes(path.join(projectRoot, "node_modules"))
  ) {
    editor.set(["compilerOptions", "types"], DEFAULT_TYPES);
    suggested.push({ key: "types", change: `set to ${formatValue(DEFAULT_TYPES)}` });
  }

  for (const desired of SUGGESTED_COMPILER_OPTIONS) {
    const isSet =
      option(desired.key) !== undefined ||
      (desired.satisfiedBy !== undefined && option(desired.satisfiedBy) !== undefined);
    if (!isSet) {
      editor.set(["compilerOptions", desired.key], desired.value);
      suggested.push({ key: desired.key, change: `set to ${formatValue(desired.value)}` });
    }
  }

  // The Aruna aliases. Targets are relative to where TypeScript resolves them:
  // the project's own baseUrl when it has one, tsconfig.json's directory
  // otherwise.
  const targets = arunaAliasTargets(projectRoot, options.generatedDir);
  const baseUrl = option("baseUrl");
  const pathsBase =
    typeof baseUrl?.value === "string"
      ? path.resolve(path.dirname(baseUrl.file), baseUrl.value)
      : tsconfigDir;
  const expected = Object.fromEntries(
    Object.entries(targets).map(([alias, target]) => [alias, relativeSpecifier(pathsBase, target)]),
  );
  const paths = option("paths");
  const currentPaths = isRecord(paths?.value) ? paths.value : undefined;
  // Without a baseUrl an inherited paths block resolves against its own file.
  const currentPathsBase =
    paths === undefined || typeof baseUrl?.value === "string"
      ? pathsBase
      : path.dirname(paths.file);

  const declaredIn =
    paths !== undefined && !paths.own ? relativeGlob(projectRoot, paths.file) : undefined;
  const aliases: TsconfigAliasStatus[] = Object.entries(expected).map(([alias, target]) => {
    const entry = currentPaths?.[alias];
    const actual = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined;
    if (actual === undefined) {
      return { alias, expected: target, status: "missing" };
    }
    const resolved = path.resolve(currentPathsBase, actual);
    return {
      alias,
      expected: target,
      actual,
      ...(declaredIn !== undefined ? { declaredIn } : {}),
      status: resolved === targets[alias] ? "ok" : "stale",
    };
  });

  const aliasReason = "Aruna's generated modules and vendored runtime resolve through them";
  if (paths?.own === true && currentPaths !== undefined) {
    const added: string[] = [];
    const realigned: string[] = [];
    const dropped: string[] = [];
    for (const { alias, actual, status } of aliases) {
      // A mapping that already reaches the generated file stays as written,
      // unless it is non-relative with no baseUrl to resolve it (TS5090).
      if (
        status === "ok" &&
        (typeof baseUrl?.value === "string" ||
          actual?.startsWith("./") === true ||
          actual?.startsWith("../") === true)
      ) {
        continue;
      }
      editor.set(["compilerOptions", "paths", alias], [expected[alias]]);
      (status === "missing" ? added : realigned).push(alias);
    }
    // An Aruna alias the current layout no longer generates (a runtime module
    // that was removed, say) would resolve to nothing.
    for (const alias of Object.keys(currentPaths)) {
      if (isArunaOwnedAlias(alias) && !(alias in expected)) {
        editor.remove(["compilerOptions", "paths", alias]);
        dropped.push(alias);
      }
    }
    if (added.length > 0) {
      mandatory.push({
        key: "paths",
        change: `updated to add ${added.join(", ")}`,
        reason: aliasReason,
      });
    }
    if (realigned.length > 0) {
      mandatory.push({
        key: "paths",
        change: `updated to remap ${realigned.join(", ")}`,
        reason: aliasReason,
      });
    }
    if (dropped.length > 0) {
      mandatory.push({
        key: "paths",
        change: `updated to drop ${dropped.join(", ")}`,
        reason: "Aruna no longer generates them",
      });
    }
  } else if (paths !== undefined && currentPaths !== undefined) {
    // TypeScript replaces an inherited paths block wholesale, so writing the
    // Aruna aliases here means carrying the inherited ones over too.
    const merged: Record<string, unknown> = {};
    for (const [alias, entry] of Object.entries(currentPaths)) {
      if (isArunaOwnedAlias(alias)) {
        continue;
      }
      merged[alias] = Array.isArray(entry)
        ? entry.map((target) =>
            typeof target === "string"
              ? relativeSpecifier(pathsBase, path.resolve(currentPathsBase, target))
              : target,
          )
        : entry;
    }
    for (const [alias, target] of Object.entries(expected)) {
      merged[alias] = [target];
    }
    editor.set(["compilerOptions", "paths"], merged);
    mandatory.push({
      key: "paths",
      change: `set to the Aruna aliases plus the ones inherited from ${relativeSpecifier(tsconfigDir, paths.file)}`,
      reason: "TypeScript replaces an inherited paths block wholesale",
    });
  } else {
    editor.set(
      ["compilerOptions", "paths"],
      Object.fromEntries(Object.entries(expected).map(([alias, target]) => [alias, [target]])),
    );
    mandatory.push({
      key: "paths",
      change: `set to map ${Object.keys(expected).join(", ")}`,
      reason: aliasReason,
    });
  }

  // TypeScript's wildcards skip dot-folders, so `src/**/*` never reaches a
  // generated dir such as `src/.aruna`, where the generated entry scripts live.
  // Like Next.js with `.next/types`, the generated dir is named outright.
  const generatedDirAbs = path.resolve(projectRoot, options.generatedDir);
  const generatedRel = relativeGlob(tsconfigDir, generatedDirAbs);
  const generatedGlob = `${generatedRel}/**/*.ts`;
  const hiddenFromWildcards = generatedRel
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
  const include = topLevel("include");
  if (include === undefined) {
    // A project that lists its `files` instead has chosen its program itself.
    if (topLevel("files") === undefined) {
      const value = [
        "src/**/*.ts",
        "src/**/*.tsx",
        ...(hiddenFromWildcards ? [generatedGlob] : []),
      ];
      editor.set(["include"], value);
      suggested.push({ key: "include", change: `set to ${formatValue(value)}` });
    }
  } else if (hiddenFromWildcards && Array.isArray(include.value)) {
    const fromDir = path.dirname(include.file);
    const covered = include.value.some(
      (entry) =>
        typeof entry === "string" && isInsideOrEqual(generatedDirAbs, path.resolve(fromDir, entry)),
    );
    if (!covered) {
      appendEntry(["include"], include, generatedGlob);
      mandatory.push({
        key: "include",
        change: `updated to add ${generatedGlob}`,
        reason: "wildcards skip dot-folders, and Aruna generates files into one",
      });
    }
  }

  if (topLevel("exclude") === undefined) {
    editor.set(["exclude"], DEFAULT_EXCLUDE);
    suggested.push({ key: "exclude", change: `set to ${formatValue(DEFAULT_EXCLUDE)}` });
  }

  const contents = editor.text();
  return {
    status: existing === undefined ? "create" : contents === existing ? "ok" : "update",
    tsconfigPath,
    contents,
    mandatory,
    suggested,
    aliases,
    retiredFragment,
  };
}

// Writes what planTsconfigSetup worked out. A no-op for "ok" and "unreadable".
export function applyTsconfigSetup(setup: TsconfigSetup): void {
  if (setup.status === "create" || setup.status === "update") {
    fs.writeFileSync(setup.tsconfigPath, setup.contents, "utf8");
  }
}

// Plans and writes in one step: what init, build, dev, and test call.
export function setUpTsconfig(options: TsconfigSetupOptions): TsconfigSetup {
  const setup = planTsconfigSetup(options);
  applyTsconfigSetup(setup);
  return setup;
}

function formatChange(change: TsconfigChange, verb: "was" | "would be"): string {
  return `${change.key} ${verb} ${change.change}${change.reason !== undefined ? ` (${change.reason})` : ""}`;
}

// The JSON form of a setup for `--json` output: the changes, not the file.
export type TsconfigSetupSummary = {
  readonly status: TsconfigSetup["status"];
  readonly mandatory: readonly TsconfigChange[];
  readonly suggested: readonly TsconfigChange[];
  readonly error?: string | undefined;
};

export function tsconfigSetupSummary(setup: TsconfigSetup): TsconfigSetupSummary {
  if (setup.status === "unreadable") {
    return { status: setup.status, mandatory: [], suggested: [], error: setup.error };
  }
  return { status: setup.status, mandatory: setup.mandatory, suggested: setup.suggested };
}

// The Next.js-style account of what the upkeep did — or, for a plan that was
// not written, what it would do: a headline, then the changes. Empty when
// there is nothing to say.
export function formatTsconfigSetup(
  setup: TsconfigSetup | TsconfigSetupSummary,
  mode: "applied" | "pending",
): string[] {
  if (setup.status === "unreadable" || setup.status === "ok") {
    return [];
  }
  if (setup.status === "create" && mode === "applied") {
    return ["created tsconfig.json with the settings roblox-ts and Aruna need"];
  }
  const verb = mode === "applied" ? "was" : "would be";
  const lines: string[] = [
    mode === "applied"
      ? "reconfigured tsconfig.json for roblox-ts and Aruna"
      : setup.status === "create"
        ? "tsconfig.json is missing"
        : "tsconfig.json needs reconfiguring for roblox-ts and Aruna",
  ];
  if (setup.mandatory.length > 0) {
    lines.push("", "  mandatory changes:");
    for (const change of setup.mandatory) {
      lines.push(`    - ${formatChange(change, verb)}`);
    }
  }
  if (setup.suggested.length > 0) {
    lines.push("", "  suggested values (yours to change):");
    for (const change of setup.suggested) {
      lines.push(`    - ${formatChange(change, verb)}`);
    }
  }
  return lines;
}
