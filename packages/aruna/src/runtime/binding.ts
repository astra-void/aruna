export type ServerBinding = {
  readonly dispose: () => void;
};

export type ServerBindingLike = ServerBinding | (() => void) | void;

export function createServerBinding(dispose: () => void): ServerBinding {
  let disposed = false;

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      dispose();
    },
  };
}

export function normalizeServerBinding(binding: ServerBindingLike): ServerBinding {
  if (binding === undefined) {
    return createServerBinding(() => {});
  }

  if (typeof binding === "function") {
    return createServerBinding(binding);
  }

  return createServerBinding(() => {
    binding.dispose();
  });
}
