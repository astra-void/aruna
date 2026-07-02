import type { ActionInvokeOptions, ActionInvoker } from "../runtime/client.js";
import { clearActionInvoker, setActionInvoker } from "../runtime/client.js";
import { createActionInvoker } from "../runtime/roblox-action-remote.js";

// The client counterpart of a server transport: the wire connection actions are
// invoked through. Any `(actionId, input, options) => Promise` works — the
// default Roblox RemoteEvent invoker, a RemoteFunction invoker, or an in-memory
// invoker in tests.
export type ClientTransport = ActionInvoker;

export type ClientApp = {
  // Invokes an action through this app's transport directly, without going
  // through the module-global `invokeAction`. Prefer this (or pass the app
  // handle to controllers) when call ordering is hard to guarantee: it removes
  // the "controller fired before createClientApp installed the global" footgun.
  readonly invoke: (
    actionId: string,
    input: unknown,
    options?: ActionInvokeOptions,
  ) => Promise<unknown>;
  readonly dispose: () => void;
};

export type CreateClientAppOptions = {
  // The wire connection used to invoke actions — the client counterpart of
  // `createServerApp({ transport })`. When omitted, the app builds the default
  // Roblox invoker (`createActionInvoker()`), which waits for the action remote
  // the server transport creates. A caller-supplied transport stays
  // caller-owned; only the default one is disposed with the app.
  readonly transport?: ClientTransport;
};

export function createClientApp(options?: CreateClientAppOptions): ClientApp {
  let ownedTransport: ReturnType<typeof createActionInvoker> | undefined;
  let transport = options?.transport;
  if (transport === undefined) {
    ownedTransport = createActionInvoker();
    transport = ownedTransport;
  }

  // Still installs the global so generated `$aruna/actions/client` stubs (which
  // call `invokeAction`) work. The returned `invoke` is the injection-friendly
  // alternative for code that holds the app handle.
  setActionInvoker(transport);

  let disposed = false;

  return {
    invoke(actionId, input, invokeOptions) {
      if (disposed) {
        return Promise.reject(
          new Error(`Aruna client app is disposed; cannot invoke "${actionId}".`),
        );
      }

      return Promise.resolve(transport(actionId, input, invokeOptions));
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      clearActionInvoker();
      ownedTransport?.dispose();
    },
  };
}
