type Provider<T> = (container: DIContainer) => T | Promise<T>;

/**
 * Minimal async-aware DI container used to wire the app context.
 * Providers are lazily resolved once and cached.
 * 
 * Note: Renamed from AppContainer to avoid conflict with app/AppContainer.ts
 * which handles HTTP server lifecycle.
 */
export class DIContainer {
  private readonly providers = new Map<string, Provider<unknown>>();
  private readonly singletons = new Map<string, Promise<unknown>>();

  register<T>(key: string, provider: Provider<T>): void {
    this.providers.set(key, provider as Provider<unknown>);
    this.singletons.delete(key);
  }

  /**
   * Override an existing provider (useful for tests or scoped contexts).
   * Clears any cached singleton for the key.
   */
  override<T>(key: string, provider: Provider<T>): void {
    this.register(key, provider);
  }

  async resolve<T>(key: string): Promise<T> {
    if (this.singletons.has(key)) {
      return this.singletons.get(key) as Promise<T>;
    }
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(`Provider not registered: ${key}`);
    }
    const instancePromise = Promise.resolve(provider(this));
    this.singletons.set(key, instancePromise);
    return instancePromise as Promise<T>;
  }
}

