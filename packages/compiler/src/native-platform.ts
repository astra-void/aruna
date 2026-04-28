export type NativeTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "win32-x64-msvc"
  | "win32-arm64-msvc"
  | "linux-x64-gnu"
  | "linux-arm64-gnu"
  | "linux-x64-musl"
  | "linux-arm64-musl";

export type NativeTargetInfo = {
  target: NativeTarget;
  npmPackageName: string;
  artifactName: string;
  rustTarget?: string | undefined;
  os: NodeJS.Platform;
  arch: NodeJS.Architecture;
  libc?: "gnu" | "musl" | undefined;
};

export type RuntimeInfo = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  report?: {
    header?: {
      glibcVersionRuntime?: string | undefined;
    } | undefined;
    sharedObjects?: string[] | undefined;
  } | undefined;
  libc?: "gnu" | "musl" | undefined;
};

export const SUPPORTED_NATIVE_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64-msvc",
  "win32-arm64-msvc",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "linux-x64-musl",
  "linux-arm64-musl",
] as const satisfies readonly NativeTarget[];

type LinuxLibc = "gnu" | "musl";

type NativeTargetMap = Record<NativeTarget, NativeTargetInfo>;

type NodeReport = {
  header?: {
    glibcVersionRuntime?: string | undefined;
  } | undefined;
  sharedObjects?: string[] | undefined;
};

const NATIVE_TARGETS: NativeTargetMap = {
  "darwin-arm64": {
    target: "darwin-arm64",
    npmPackageName: "@arunajs/compiler-darwin-arm64",
    artifactName: "compiler.darwin-arm64.node",
    os: "darwin",
    arch: "arm64",
  },
  "darwin-x64": {
    target: "darwin-x64",
    npmPackageName: "@arunajs/compiler-darwin-x64",
    artifactName: "compiler.darwin-x64.node",
    os: "darwin",
    arch: "x64",
  },
  "win32-x64-msvc": {
    target: "win32-x64-msvc",
    npmPackageName: "@arunajs/compiler-win32-x64-msvc",
    artifactName: "compiler.win32-x64-msvc.node",
    os: "win32",
    arch: "x64",
  },
  "win32-arm64-msvc": {
    target: "win32-arm64-msvc",
    npmPackageName: "@arunajs/compiler-win32-arm64-msvc",
    artifactName: "compiler.win32-arm64-msvc.node",
    os: "win32",
    arch: "arm64",
  },
  "linux-x64-gnu": {
    target: "linux-x64-gnu",
    npmPackageName: "@arunajs/compiler-linux-x64-gnu",
    artifactName: "compiler.linux-x64-gnu.node",
    rustTarget: "x86_64-unknown-linux-gnu",
    os: "linux",
    arch: "x64",
    libc: "gnu",
  },
  "linux-arm64-gnu": {
    target: "linux-arm64-gnu",
    npmPackageName: "@arunajs/compiler-linux-arm64-gnu",
    artifactName: "compiler.linux-arm64-gnu.node",
    rustTarget: "aarch64-unknown-linux-gnu",
    os: "linux",
    arch: "arm64",
    libc: "gnu",
  },
  "linux-x64-musl": {
    target: "linux-x64-musl",
    npmPackageName: "@arunajs/compiler-linux-x64-musl",
    artifactName: "compiler.linux-x64-musl.node",
    rustTarget: "x86_64-unknown-linux-musl",
    os: "linux",
    arch: "x64",
    libc: "musl",
  },
  "linux-arm64-musl": {
    target: "linux-arm64-musl",
    npmPackageName: "@arunajs/compiler-linux-arm64-musl",
    artifactName: "compiler.linux-arm64-musl.node",
    rustTarget: "aarch64-unknown-linux-musl",
    os: "linux",
    arch: "arm64",
    libc: "musl",
  },
};

function unsupportedPlatformMessage(platform: string, arch: string): string {
  return `Aruna native compiler is not available for ${platform}/${arch}.`;
}

function isNativeTarget(target: string): target is NativeTarget {
  return target in NATIVE_TARGETS;
}

function detectRuntimeLibc(runtime?: RuntimeInfo): LinuxLibc | null {
  if (runtime?.libc) {
    return runtime.libc;
  }

  const report =
    runtime?.report ?? (typeof process.report?.getReport === "function" ? (process.report.getReport() as NodeReport) : null);
  const glibcVersionRuntime = report?.header?.glibcVersionRuntime;
  if (typeof glibcVersionRuntime === "string" && glibcVersionRuntime.length > 0) {
    return "gnu";
  }

  const sharedObjects = report?.sharedObjects;
  if (Array.isArray(sharedObjects) && sharedObjects.some((sharedObject) => sharedObject.includes("musl"))) {
    return "musl";
  }

  return null;
}

function resolveLinuxTarget(arch: NodeJS.Architecture, libc: LinuxLibc | null): NativeTarget {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(unsupportedPlatformMessage("linux", arch));
  }

  if (libc === "musl") {
    return arch === "x64" ? "linux-x64-musl" : "linux-arm64-musl";
  }

  if (libc === "gnu") {
    return arch === "x64" ? "linux-x64-gnu" : "linux-arm64-gnu";
  }

  throw new Error(
    `Aruna native compiler could not confirm a glibc- or musl-based Linux runtime for linux/${arch}. ` +
      `Expected one of: linux-x64-gnu, linux-arm64-gnu, linux-x64-musl, linux-arm64-musl.`,
  );
}

export function nativePackageName(target: NativeTarget): string {
  return NATIVE_TARGETS[target].npmPackageName;
}

export function nativeArtifactName(target: NativeTarget): string {
  return NATIVE_TARGETS[target].artifactName;
}

export function nativeTargetInfo(target: NativeTarget): NativeTargetInfo {
  return NATIVE_TARGETS[target];
}

export function resolveNativeTarget(runtime: RuntimeInfo = { platform: process.platform, arch: process.arch }): NativeTarget {
  const { platform, arch } = runtime;

  if (platform === "darwin") {
    if (arch === "arm64") {
      return "darwin-arm64";
    }
    if (arch === "x64") {
      return "darwin-x64";
    }
    throw new Error(unsupportedPlatformMessage(platform, arch));
  }

  if (platform === "win32") {
    if (arch === "x64") {
      return "win32-x64-msvc";
    }
    if (arch === "arm64") {
      return "win32-arm64-msvc";
    }
    throw new Error(unsupportedPlatformMessage(platform, arch));
  }

  if (platform === "linux") {
    return resolveLinuxTarget(arch, detectRuntimeLibc(runtime));
  }

  throw new Error(unsupportedPlatformMessage(platform, arch));
}

export function nativePackageDirectoryName(target: NativeTarget): string {
  return `compiler-${target}`;
}

export function isSupportedNativeTarget(target: string): target is NativeTarget {
  return isNativeTarget(target);
}
