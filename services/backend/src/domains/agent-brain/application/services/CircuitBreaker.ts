import { EventEmitter } from 'events';
import { logger as appLogger } from '@/shared/logger';
import { CIRCUIT_BREAKER_RESET_MS, CIRCUIT_BREAKER_SERVICE_RESET_MS } from '@/config/timeouts';

/**
 * Circuit breaker states.
 */
export enum CircuitState {
    /** Normal operation - requests pass through */
    CLOSED = 'CLOSED',
    /** Circuit tripped - fast-fail all requests */
    OPEN = 'OPEN',
    /** Testing recovery - allow limited requests */
    HALF_OPEN = 'HALF_OPEN',
}

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
    /** Number of failures before opening circuit (default: 5) */
    failureThreshold?: number;
    /** Number of successes in HALF_OPEN before closing (default: 2) */
    successThreshold?: number;
    /** Time to wait before transitioning to HALF_OPEN (ms) (default: CIRCUIT_BREAKER_RESET_MS) */
    resetTimeoutMs?: number;
    /** Optional name for logging */
    name?: string;
    /** Callback when state changes */
    onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Error thrown when circuit is open.
 */
export class CircuitOpenError extends Error {
    public readonly circuitName: string;
    public readonly state: CircuitState;
    public readonly retryAfterMs: number;

    constructor(circuitName: string, retryAfterMs: number) {
        super(`Circuit '${circuitName}' is OPEN. Retry after ${retryAfterMs}ms.`);
        this.name = 'CircuitOpenError';
        this.circuitName = circuitName;
        this.state = CircuitState.OPEN;
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * Circuit breaker statistics.
 */
export interface CircuitStats {
    state: CircuitState;
    failures: number;
    successes: number;
    totalRequests: number;
    totalFailures: number;
    totalSuccesses: number;
    lastFailureTime?: number;
    lastSuccessTime?: number;
    lastStateChange: number;
}

/**
 * CircuitBreaker implements the circuit breaker pattern to prevent
 * cascading failures when external services are down.
 * 
 * State transitions:
 * - CLOSED: Normal operation, requests pass through
 *   → Opens when failures exceed threshold
 * - OPEN: Fast-fail all requests immediately
 *   → Transitions to HALF_OPEN after timeout
 * - HALF_OPEN: Allow limited test requests
 *   → Closes if successes meet threshold
 *   → Reopens if any failure occurs
 * 
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker({
 *   name: 'openai',
 *   failureThreshold: 5,
 *   resetTimeoutMs: CIRCUIT_BREAKER_RESET_MS,
 * });
 * 
 * const result = await breaker.execute(async () => {
 *   return await openai.chat.completions.create(...);
 * });
 * ```
 */
export class CircuitBreaker extends EventEmitter {
    private readonly name: string;
    private readonly failureThreshold: number;
    private readonly successThreshold: number;
    private readonly resetTimeoutMs: number;
    private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
    private readonly logger = appLogger.child({ scope: 'CircuitBreaker' });

    private state: CircuitState = CircuitState.CLOSED;
    private failures = 0;
    private successes = 0;
    private lastFailureTime?: number;
    private lastSuccessTime?: number;
    private lastStateChange = Date.now();
    private resetTimer?: NodeJS.Timeout;

    // Stats
    private totalRequests = 0;
    private totalFailures = 0;
    private totalSuccesses = 0;

    constructor(config: CircuitBreakerConfig = {}) {
        super();
        this.name = config.name ?? 'default';
        this.failureThreshold = config.failureThreshold ?? 5;
        this.successThreshold = config.successThreshold ?? 2;
        this.resetTimeoutMs = config.resetTimeoutMs ?? CIRCUIT_BREAKER_RESET_MS;
        this.onStateChange = config.onStateChange;
    }

    /**
     * Execute a function with circuit breaker protection.
     * @throws CircuitOpenError if circuit is open
     */
    async execute<T>(fn: () => Promise<T>): Promise<T> {
        this.totalRequests++;

        // Check if we should allow the request
        if (!this.canExecute()) {
            const retryAfter = this.getRetryAfterMs();
            throw new CircuitOpenError(this.name, retryAfter);
        }

        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        } catch (error) {
            this.recordFailure();
            throw error;
        }
    }

    /**
     * Check if request can proceed.
     */
    canExecute(): boolean {
        this.checkResetTimeout();

        switch (this.state) {
            case CircuitState.CLOSED:
                return true;
            case CircuitState.OPEN:
                return false;
            case CircuitState.HALF_OPEN:
                // Allow limited requests in half-open
                return true;
        }
    }

    /**
     * Record a successful operation.
     */
    recordSuccess(): void {
        this.totalSuccesses++;
        this.lastSuccessTime = Date.now();

        switch (this.state) {
            case CircuitState.CLOSED:
                this.failures = 0; // Reset failure count on success
                break;
            case CircuitState.HALF_OPEN:
                this.successes++;
                if (this.successes >= this.successThreshold) {
                    this.transitionTo(CircuitState.CLOSED);
                }
                break;
        }
    }

    /**
     * Record a failed operation.
     */
    recordFailure(): void {
        this.totalFailures++;
        this.lastFailureTime = Date.now();

        switch (this.state) {
            case CircuitState.CLOSED:
                this.failures++;
                if (this.failures >= this.failureThreshold) {
                    this.transitionTo(CircuitState.OPEN);
                }
                break;
            case CircuitState.HALF_OPEN:
                // Any failure in half-open reopens the circuit
                this.transitionTo(CircuitState.OPEN);
                break;
        }
    }

    /**
     * Force the circuit to a specific state.
     */
    forceState(newState: CircuitState): void {
        this.transitionTo(newState);
    }

    /**
     * Reset the circuit breaker to initial state.
     */
    reset(): void {
        this.transitionTo(CircuitState.CLOSED);
        this.failures = 0;
        this.successes = 0;
        this.totalRequests = 0;
        this.totalFailures = 0;
        this.totalSuccesses = 0;
    }

    /**
     * Get current state.
     */
    getState(): CircuitState {
        this.checkResetTimeout();
        return this.state;
    }

    /**
     * Check if circuit is open.
     */
    isOpen(): boolean {
        return this.getState() === CircuitState.OPEN;
    }

    /**
     * Check if circuit is closed.
     */
    isClosed(): boolean {
        return this.getState() === CircuitState.CLOSED;
    }

    /**
     * Get time until circuit may transition from OPEN to HALF_OPEN.
     */
    getRetryAfterMs(): number {
        if (this.state !== CircuitState.OPEN) {
            return 0;
        }
        const elapsed = Date.now() - this.lastStateChange;
        return Math.max(0, this.resetTimeoutMs - elapsed);
    }

    /**
     * Get circuit breaker statistics.
     */
    getStats(): CircuitStats {
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            totalRequests: this.totalRequests,
            totalFailures: this.totalFailures,
            totalSuccesses: this.totalSuccesses,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            lastStateChange: this.lastStateChange,
        };
    }

    /**
     * Get circuit breaker name.
     */
    getName(): string {
        return this.name;
    }

    /**
     * Clean up timers.
     */
    shutdown(): void {
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = undefined;
        }
    }

    // =========================================================================
    // Private methods
    // =========================================================================

    private transitionTo(newState: CircuitState): void {
        if (this.state === newState) return;

        const oldState = this.state;
        this.state = newState;
        this.lastStateChange = Date.now();
        this.failures = 0;
        this.successes = 0;

        // Clear any existing timer
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = undefined;
        }

        // Schedule transition from OPEN to HALF_OPEN
        if (newState === CircuitState.OPEN) {
            this.resetTimer = setTimeout(() => {
                if (this.state === CircuitState.OPEN) {
                    this.transitionTo(CircuitState.HALF_OPEN);
                }
            }, this.resetTimeoutMs);
        }

        this.logger.info(
            { circuit: this.name, from: oldState, to: newState },
            `Circuit state changed`
        );

        this.onStateChange?.(oldState, newState);
        this.emit('stateChange', oldState, newState);
    }

    private checkResetTimeout(): void {
        if (this.state === CircuitState.OPEN) {
            const elapsed = Date.now() - this.lastStateChange;
            if (elapsed >= this.resetTimeoutMs) {
                this.transitionTo(CircuitState.HALF_OPEN);
            }
        }
    }
}

// =============================================================================
// Circuit Breaker Registry
// =============================================================================

/**
 * Global registry for circuit breakers.
 * Allows sharing breakers across the application.
 */
export class CircuitBreakerRegistry {
    private static instance: CircuitBreakerRegistry;
    private breakers = new Map<string, CircuitBreaker>();
    private defaultConfig: CircuitBreakerConfig = {};

    private constructor() { }

    static getInstance(): CircuitBreakerRegistry {
        if (!CircuitBreakerRegistry.instance) {
            CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
        }
        return CircuitBreakerRegistry.instance;
    }

    /**
     * Get or create a circuit breaker by name.
     */
    get(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
        if (!this.breakers.has(name)) {
            this.breakers.set(name, new CircuitBreaker({
                ...this.defaultConfig,
                ...config,
                name,
            }));
        }
        return this.breakers.get(name)!;
    }

    /**
     * Check if a breaker exists.
     */
    has(name: string): boolean {
        return this.breakers.has(name);
    }

    /**
     * Get all breaker names.
     */
    list(): string[] {
        return Array.from(this.breakers.keys());
    }

    /**
     * Get stats for all breakers.
     */
    getAllStats(): Record<string, CircuitStats> {
        const stats: Record<string, CircuitStats> = {};
        for (const [name, breaker] of this.breakers) {
            stats[name] = breaker.getStats();
        }
        return stats;
    }

    /**
     * Reset a specific breaker.
     */
    reset(name: string): void {
        this.breakers.get(name)?.reset();
    }

    /**
     * Reset all breakers.
     */
    resetAll(): void {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }

    /**
     * Shutdown all breakers.
     */
    shutdown(): void {
        for (const breaker of this.breakers.values()) {
            breaker.shutdown();
        }
        this.breakers.clear();
    }

    /**
     * Set default config for new breakers.
     */
    setDefaultConfig(config: CircuitBreakerConfig): void {
        this.defaultConfig = config;
    }
}

// Singleton export
export const circuitBreakerRegistry = CircuitBreakerRegistry.getInstance();

// =============================================================================
// Convenience functions
// =============================================================================

/**
 * Get or create circuit breaker for LLM provider.
 */
export function getLLMCircuitBreaker(provider: string): CircuitBreaker {
    return circuitBreakerRegistry.get(`llm:${provider}`, {
        failureThreshold: 5,
        successThreshold: 2,
        resetTimeoutMs: CIRCUIT_BREAKER_RESET_MS,
    });
}

/**
 * Get or create circuit breaker for tool/service.
 */
export function getServiceCircuitBreaker(service: string): CircuitBreaker {
    return circuitBreakerRegistry.get(`service:${service}`, {
        failureThreshold: 3,
        successThreshold: 1,
        resetTimeoutMs: CIRCUIT_BREAKER_SERVICE_RESET_MS,
    });
}
