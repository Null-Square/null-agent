/**
 * SandboxImageRegistry - Runtime cache of sandbox images.
 *
 * Loads images from SandboxImageService on startup, with optional refresh.
 */
import { sandboxImageService } from './SandboxImageService';
import { logger } from '@/shared/logger';
import type { SandboxImageRow } from './SandboxImageService';

const log = logger.child({ module: 'SandboxImageRegistry' });

export interface SandboxImageRegistryOptions {
    refreshIntervalMs?: number; // 0 = no refresh
}

export class SandboxImageRegistry {
    private images: Map<string, SandboxImageRow> = new Map();
    private defaultImage: SandboxImageRow | undefined;
    private refreshTimer: NodeJS.Timeout | null = null;
    private initialized = false;

    constructor(private readonly options: SandboxImageRegistryOptions = {}) { }

    /**
     * Initialize the registry by loading images from service.
     * Must be called before using getImageTag/getDefault.
     */
    async init(): Promise<void> {
        await this.refresh();
        this.initialized = true;

        if (this.options.refreshIntervalMs && this.options.refreshIntervalMs > 0) {
            this.refreshTimer = setInterval(() => {
                this.refresh().catch(err => log.error({ err }, 'Failed to refresh sandbox images'));
            }, this.options.refreshIntervalMs);
        }

        log.info({ count: this.images.size }, 'Sandbox image registry initialized');
    }

    /**
     * Refresh images from service.
     */
    async refresh(): Promise<void> {
        const rows = await sandboxImageService.list();
        const next = new Map<string, SandboxImageRow>();
        let defaultRow: SandboxImageRow | undefined;

        for (const row of rows) {
            next.set(row.name, row);
            if (row.isDefault) {
                defaultRow = row;
            }
        }

        this.images = next;
        this.defaultImage = defaultRow;
        log.debug({ count: rows.length }, 'Sandbox images refreshed');
    }

    /**
     * Get image tag by name (e.g., 'base', 'network-scan').
     * Returns undefined if not found.
     */
    getImageTag(name: string): string | undefined {
        return this.images.get(name)?.imageTag;
    }

    /**
     * Get the default image tag.
     */
    getDefaultImageTag(): string | undefined {
        return this.defaultImage?.imageTag;
    }

    /**
     * Get image row by name.
     */
    getImage(name: string): SandboxImageRow | undefined {
        return this.images.get(name);
    }

    /**
     * List all image names.
     */
    listNames(): string[] {
        return Array.from(this.images.keys());
    }

    /**
     * Get a mapping of name -> imageTag for compatibility with existing code.
     */
    getProfileMap(): Record<string, string> {
        const map: Record<string, string> = {};
        for (const [name, row] of this.images) {
            map[name] = row.imageTag;
        }
        return map;
    }

    /**
     * Check if initialized.
     */
    isReady(): boolean {
        return this.initialized;
    }

    /**
     * Stop refresh timer.
     */
    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
}

// Singleton instance (initialized on first use)
let _instance: SandboxImageRegistry | null = null;

export async function getSandboxImageRegistry(): Promise<SandboxImageRegistry> {
    if (!_instance) {
        _instance = new SandboxImageRegistry({ refreshIntervalMs: 60_000 });
        await _instance.init();
    }
    return _instance;
}

export function getSandboxImageRegistrySync(): SandboxImageRegistry | null {
    return _instance;
}
