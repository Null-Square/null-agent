import { logger as appLogger } from '@/shared/logger';
import type { StreamEvent } from '../../domain/types';

/**
 * StreamBuffer configuration.
 */
export interface StreamBufferConfig {
    /** Maximum events to buffer before dropping. Default: 1000 */
    maxBufferSize?: number;
    /** Flush interval in milliseconds. Default: 50 */
    flushIntervalMs?: number;
    /** Maximum events to send per flush. Default: 100 */
    batchSize?: number;
    /** Callback when events are dropped due to buffer overflow */
    onDrop?: (dropped: number) => void;
}

/**
 * StreamBuffer provides buffered event delivery with backpressure handling.
 * 
 * Features:
 * - Batches events for efficient delivery
 * - Configurable buffer limits to prevent memory issues
 * - Drops oldest events when buffer overflows (graceful degradation)
 * - Async flushing to avoid blocking producers
 * 
 * This is useful for high-throughput streaming where clients may
 * not keep up with event production rate.
 */
export class StreamBuffer<T = StreamEvent> {
    private readonly maxBufferSize: number;
    private readonly flushIntervalMs: number;
    private readonly batchSize: number;
    private readonly onDrop?: (dropped: number) => void;
    private readonly logger = appLogger.child({ scope: 'StreamBuffer' });

    private buffer: T[] = [];
    private flushInterval?: NodeJS.Timeout;
    private flushing = false;
    private subscriber?: (events: T[]) => void | Promise<void>;
    private droppedCount = 0;

    constructor(config: StreamBufferConfig = {}) {
        this.maxBufferSize = config.maxBufferSize ?? 1000;
        this.flushIntervalMs = config.flushIntervalMs ?? 50;
        this.batchSize = config.batchSize ?? 100;
        this.onDrop = config.onDrop;
    }

    /**
     * Set the subscriber that receives batched events.
     */
    setSubscriber(subscriber: (events: T[]) => void | Promise<void>): void {
        this.subscriber = subscriber;
    }

    /**
     * Start the flush interval.
     */
    start(): void {
        if (this.flushInterval) return;
        this.flushInterval = setInterval(() => this.flush(), this.flushIntervalMs);
    }

    /**
     * Stop the flush interval and flush remaining events.
     */
    async stop(): Promise<void> {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = undefined;
        }
        // Final flush
        await this.flush();
    }

    /**
     * Push an event to the buffer.
     * Returns false if the event was dropped due to buffer overflow.
     */
    push(event: T): boolean {
        if (this.buffer.length >= this.maxBufferSize) {
            // Drop oldest events to make room
            const toDrop = Math.max(1, Math.floor(this.maxBufferSize * 0.1)); // Drop 10% or at least 1
            this.buffer.splice(0, toDrop);
            this.droppedCount += toDrop;

            this.logger.warn(
                { dropped: toDrop, totalDropped: this.droppedCount, bufferSize: this.buffer.length },
                'Buffer overflow - dropping oldest events'
            );

            this.onDrop?.(toDrop);
        }

        this.buffer.push(event);
        return true;
    }

    /**
     * Flush buffered events to subscriber.
     */
    async flush(): Promise<number> {
        if (this.flushing || !this.subscriber || this.buffer.length === 0) {
            return 0;
        }

        this.flushing = true;
        let flushed = 0;

        try {
            // Process in batches
            while (this.buffer.length > 0) {
                const batch = this.buffer.splice(0, this.batchSize);
                try {
                    await this.subscriber(batch);
                    flushed += batch.length;
                } catch (error) {
                    this.logger.error({ err: error, batchSize: batch.length }, 'Error flushing batch');
                    // Don't re-add events to buffer to prevent infinite loops
                    break;
                }
            }
        } finally {
            this.flushing = false;
        }

        return flushed;
    }

    /**
     * Get current buffer size.
     */
    get size(): number {
        return this.buffer.length;
    }

    /**
     * Get total dropped event count.
     */
    get dropped(): number {
        return this.droppedCount;
    }

    /**
     * Check if buffer is active (has subscriber and interval).
     */
    get isActive(): boolean {
        return !!this.flushInterval && !!this.subscriber;
    }

    /**
     * Clear the buffer without flushing.
     */
    clear(): void {
        this.buffer = [];
    }

    /**
     * Get buffer stats for monitoring.
     */
    getStats(): { size: number; dropped: number; maxSize: number } {
        return {
            size: this.buffer.length,
            dropped: this.droppedCount,
            maxSize: this.maxBufferSize,
        };
    }
}

/**
 * Create a default stream buffer for SSE events.
 */
export function createEventBuffer(): StreamBuffer<StreamEvent> {
    return new StreamBuffer({
        maxBufferSize: 500,
        flushIntervalMs: 50,
        batchSize: 50,
    });
}
