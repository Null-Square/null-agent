let readOverride: () => boolean = () => false;

/** Called only by the development-only panel chunk. Production never imports its preference store. */
export const registerScopeAutoVerifyOverrideReader = (reader: () => boolean): (() => void) => {
  readOverride = reader;
  return () => {
    if (readOverride === reader) readOverride = () => false;
  };
};

export const isScopeAutoVerifyEnabled = (): boolean => readOverride();
