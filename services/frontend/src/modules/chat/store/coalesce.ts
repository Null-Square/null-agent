type FrameHandle = number | undefined;

const getAnimationFrameApi = () => {
  if (typeof window === 'undefined') {
    return {
      request: undefined,
      cancel: undefined,
    } as const;
  }

  return {
    request: window.requestAnimationFrame?.bind(window),
    cancel: window.cancelAnimationFrame?.bind(window),
  } as const;
};

export interface Coalescer<Key extends string> {
  append: (key: Key, chunk: string) => void;
  flush: () => void;
  reset: () => void;
}

export function createRafCoalescer<Key extends string>(
  flushEntries: (entries: Array<[Key, string]>) => void
): Coalescer<Key> {
  let buffer: Partial<Record<Key, string>> = {};
  let rafHandle: FrameHandle;

  const { request, cancel } = getAnimationFrameApi();

  const doFlush = () => {
    if (typeof cancel === 'function' && rafHandle !== undefined) {
      cancel(rafHandle);
      rafHandle = undefined;
    }

    const entries = Object.entries(buffer) as Array<[Key, string]>;
    buffer = {};

    if (!entries.length) {
      return;
    }

    flushEntries(entries);
  };

  const scheduleFlush = () => {
    if (typeof request !== 'function') {
      doFlush();
      return;
    }

    if (rafHandle !== undefined) {
      return;
    }

    rafHandle = request(() => {
      rafHandle = undefined;
      doFlush();
    });
  };

  return {
    append(key: Key, chunk: string) {
      if (!chunk) {
        return;
      }
      buffer[key] = (buffer[key] ?? '') + chunk;
      scheduleFlush();
    },
    flush: doFlush,
    reset() {
      if (typeof cancel === 'function' && rafHandle !== undefined) {
        cancel(rafHandle);
      }
      rafHandle = undefined;
      buffer = {};
    },
  };
}
