export class DeadlockDetector {
    private readonly executedToolCalls: Array<{ name: string; args: string }> = [];
    private readonly limit: number;

    constructor(limit: number = 3) {
        this.limit = limit;
    }

    record(name: string, args: string): void {
        this.executedToolCalls.push({ name, args });
    }

    isDeadlocked(name: string, args: string): boolean {
        const seenCount = this.executedToolCalls.filter(
            (item) => item.name === name && item.args === args,
        ).length;

        return seenCount >= this.limit - 1;
    }

    clear(): void {
        this.executedToolCalls.length = 0;
    }
}
