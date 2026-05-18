import type { ActionInvoker } from "../runtime/client.js";
import { clearActionInvoker, setActionInvoker } from "../runtime/client.js";

export type ClientApp = {
  readonly dispose: () => void;
};

export type CreateClientAppOptions = {
  readonly invoker: ActionInvoker;
};

export function createClientApp(options: CreateClientAppOptions): ClientApp {
  setActionInvoker(options.invoker);

  let disposed = false;

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      clearActionInvoker();
    },
  };
}
