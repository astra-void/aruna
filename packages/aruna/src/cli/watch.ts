import path from "node:path";

// Directories `aruna build --watch` must never rebuild on: everything the build
// itself (or rbxtsc after it) writes back into the project. Watching these would
// turn every build into the trigger for the next one.
const DEFAULT_IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "out",
  "include",
  "dist",
]);

export type WatchFilterOptions = {
  // The generatedDir, relative to the watched root (posix or platform separators).
  readonly generatedDir: string;
};

// Decides whether a change reported by fs.watch at `relPath` (relative to the
// watched project root) should schedule a rebuild. Generated/emitted trees are
// ignored so the build's own writes never re-trigger it.
export function shouldRebuildOnChange(
  relPath: string,
  options: WatchFilterOptions,
): boolean {
  if (relPath.length === 0) {
    return false;
  }

  const normalized = relPath.split(path.sep).join("/");
  const segments = normalized.split("/");

  if (segments.some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment))) {
    return false;
  }

  const generatedDir = options.generatedDir.split(path.sep).join("/").replace(/\/+$/, "");
  if (
    generatedDir.length > 0 &&
    (normalized === generatedDir || normalized.startsWith(`${generatedDir}/`))
  ) {
    return false;
  }

  return true;
}

export type RebuildScheduler = {
  // Report a (filtered) change. Coalesces bursts within the debounce window and
  // queues at most one follow-up run while a build is in flight, so a save storm
  // yields one rebuild and a change landing mid-build yields exactly one more.
  readonly notify: () => void;
  // Resolves once no run is in flight and none is queued (used by tests).
  readonly idle: () => Promise<void>;
};

export function createRebuildScheduler(
  run: () => Promise<void>,
  debounceMs: number,
  setTimer: (callback: () => void, ms: number) => unknown = (callback, ms) =>
    setTimeout(callback, ms),
): RebuildScheduler {
  let timerArmed = false;
  let running = false;
  let rerunQueued = false;
  let idleResolvers: Array<() => void> = [];

  const settleIfIdle = (): void => {
    if (!timerArmed && !running && !rerunQueued) {
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  };

  const execute = (): void => {
    timerArmed = false;
    if (running) {
      rerunQueued = true;
      return;
    }
    running = true;
    void run()
      .catch(() => {
        // A failed build stays on screen via the run callback's own rendering;
        // the watcher keeps watching.
      })
      .finally(() => {
        running = false;
        if (rerunQueued) {
          rerunQueued = false;
          execute();
          return;
        }
        settleIfIdle();
      });
  };

  return {
    notify() {
      // A queued rerun already covers this change; arming another timer would
      // schedule a redundant third build.
      if (timerArmed || rerunQueued) {
        return;
      }
      timerArmed = true;
      setTimer(execute, debounceMs);
    },
    idle() {
      return new Promise((resolve) => {
        idleResolvers.push(resolve);
        settleIfIdle();
      });
    },
  };
}
