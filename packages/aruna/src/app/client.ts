import type { ActionInvokeOptions, ActionInvoker } from "../runtime/client.js";
import { clearActionInvoker, setActionInvoker } from "../runtime/client.js";

export type ClientApp = {
  // Invokes an action through this app's invoker directly, without going through
  // the module-global `invokeAction`. Prefer this (or pass the app handle to
  // controllers) when call ordering is hard to guarantee: it removes the
  // "controller fired before createClientApp installed the global" footgun.
  readonly invoke: (
    actionId: string,
    input: unknown,
    options?: ActionInvokeOptions,
  ) => Promise<unknown>;
  readonly dispose: () => void;
};

export type CreateClientAppOptions = {
  readonly invoker: ActionInvoker;
};

export function createClientApp(options: CreateClientAppOptions): ClientApp {
  // Still installs the global so generated `$aruna/actions/client` stubs (which
  // call `invokeAction`) work. The returned `invoke` is the injection-friendly
  // alternative for code that holds the app handle.
  setActionInvoker(options.invoker);

  let disposed = false;

  return {
    invoke(actionId, input, invokeOptions) {
      if (disposed) {
        return Promise.reject(
          new Error(`Aruna client app is disposed; cannot invoke "${actionId}".`),
        );
      }

      return Promise.resolve(options.invoker(actionId, input, invokeOptions));
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      clearActionInvoker();
    },
  };
}
