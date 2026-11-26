import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { StreamBuffer, createEventBuffer } from '@/domains/agent-brain/application/services/StreamBuffer';

// =============================================================================
// Tests
// =============================================================================

describe('StreamBuffer', () => {
    let buffer: StreamBuffer<string>;

    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(async () => {
        await buffer?.stop();
    });

    describe('push', () => {
        it('should add events to buffer', () => {
            buffer = new StreamBuffer({ maxBufferSize: 10 });

            buffer.push('event1');
            buffer.push('event2');

            expect(buffer.size).toBe(2);
        });

        it('should drop oldest events on overflow', () => {
            const onDrop = vi.fn();
            buffer = new StreamBuffer({ maxBufferSize: 5, onDrop });

            // Fill buffer
            for (let i = 0; i < 5; i++) {
                buffer.push(`event${i}`);
            }

            // Overflow
            buffer.push('overflow-event');

            expect(onDrop).toHaveBeenCalled();
            expect(buffer.dropped).toBeGreaterThan(0);
        });
    });

    describe('flush', () => {
        it('should deliver events to subscriber', async () => {
            const received: string[][] = [];
            buffer = new StreamBuffer({ batchSize: 10 });
            buffer.setSubscriber((events) => { received.push(events); });

            buffer.push('event1');
            buffer.push('event2');

            const flushed = await buffer.flush();

            expect(flushed).toBe(2);
            expect(received).toHaveLength(1);
            expect(received[0]).toEqual(['event1', 'event2']);
        });

        it('should batch events according to batchSize', async () => {
            const received: string[][] = [];
            buffer = new StreamBuffer({ batchSize: 2 });
            buffer.setSubscriber((events) => { received.push(events); });

            buffer.push('event1');
            buffer.push('event2');
            buffer.push('event3');
            buffer.push('event4');
            buffer.push('event5');

            await buffer.flush();

            expect(received).toHaveLength(3); // 2, 2, 1
            expect(received[0]).toEqual(['event1', 'event2']);
            expect(received[1]).toEqual(['event3', 'event4']);
            expect(received[2]).toEqual(['event5']);
        });

        it('should handle async subscriber', async () => {
            const received: string[][] = [];
            buffer = new StreamBuffer({ batchSize: 10 });
            buffer.setSubscriber(async (events) => {
                await new Promise(r => setTimeout(r, 10));
                received.push(events);
            });

            buffer.push('event1');
            await buffer.flush();

            expect(received).toHaveLength(1);
        });

        it('should not flush when no subscriber', async () => {
            buffer = new StreamBuffer();
            buffer.push('event1');

            const flushed = await buffer.flush();

            expect(flushed).toBe(0);
            expect(buffer.size).toBe(1);
        });
    });

    describe('start/stop', () => {
        it('should automatically flush on interval', async () => {
            const received: string[][] = [];
            buffer = new StreamBuffer({ flushIntervalMs: 20, batchSize: 10 });
            buffer.setSubscriber((events) => { received.push(events); });
            buffer.start();

            buffer.push('event1');

            await new Promise(r => setTimeout(r, 50));

            expect(received.length).toBeGreaterThan(0);
        });

        it('should flush remaining on stop', async () => {
            const received: string[][] = [];
            buffer = new StreamBuffer({ flushIntervalMs: 1000, batchSize: 10 });
            buffer.setSubscriber((events) => { received.push(events); });
            buffer.start();

            buffer.push('event1');
            await buffer.stop();

            expect(received.length).toBe(1);
        });
    });

    describe('isActive', () => {
        it('should return true when started with subscriber', () => {
            buffer = new StreamBuffer();
            buffer.setSubscriber(() => { });
            buffer.start();

            expect(buffer.isActive).toBe(true);
        });

        it('should return false when no subscriber', () => {
            buffer = new StreamBuffer();
            buffer.start();

            expect(buffer.isActive).toBe(false);
        });
    });

    describe('getStats', () => {
        it('should return buffer statistics', () => {
            buffer = new StreamBuffer({ maxBufferSize: 100 });
            buffer.push('event1');
            buffer.push('event2');

            const stats = buffer.getStats();

            expect(stats.size).toBe(2);
            expect(stats.dropped).toBe(0);
            expect(stats.maxSize).toBe(100);
        });
    });

    describe('clear', () => {
        it('should clear buffer without flushing', () => {
            buffer = new StreamBuffer();
            buffer.push('event1');
            buffer.push('event2');

            buffer.clear();

            expect(buffer.size).toBe(0);
        });
    });
});

describe('createEventBuffer', () => {
    it('should create a StreamBuffer for events', () => {
        const buffer = createEventBuffer();
        expect(buffer).toBeInstanceOf(StreamBuffer);

        const stats = buffer.getStats();
        expect(stats.maxSize).toBe(500);
    });
});







