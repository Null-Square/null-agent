/**
 * SeedRegistry - Base class for loading seed manifests from YAML/JSON files.
 * 
 * Similar to ManifestRegistry but designed for configuration/seed data
 * with support for both YAML and JSON formats.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import type { ZodType, ZodTypeDef } from 'zod';
import { logger } from '@/shared/logger';

export interface SeedRegistryOptions<T> {
    /** Directory containing seed files */
    directory: string;
    /** Zod schema for validation */
    schema: ZodType<T, ZodTypeDef, unknown>;
    /** File extensions to look for (default: ['.yaml', '.yml', '.json']) */
    extensions?: string[];
    /** Whether to watch for changes (dev mode) */
    devWatch?: boolean;
}

export interface SeedRecord<T> {
    /** The parsed and validated data */
    data: T;
    /** Source file path */
    sourcePath: string;
    /** File name without extension */
    name: string;
}

export class SeedRegistry<T> {
    protected readonly directory: string;
    protected readonly schema: ZodType<T, ZodTypeDef, unknown>;
    protected readonly extensions: string[];
    protected readonly devWatch: boolean;
    protected records: Map<string, SeedRecord<T>> = new Map();
    private watcher?: { close: () => void };

    constructor(options: SeedRegistryOptions<T>) {
        this.directory = options.directory;
        this.schema = options.schema;
        this.extensions = options.extensions ?? ['.yaml', '.yml', '.json'];
        this.devWatch = Boolean(options.devWatch);
    }

    /**
     * Initialize the registry by loading all seed files.
     */
    async init(): Promise<void> {
        await this.refresh();
        if (this.devWatch) {
            await this.startWatcher();
        }
    }

    /**
     * Dispose of the registry and stop watching.
     */
    dispose(): void {
        this.watcher?.close();
        this.watcher = undefined;
        this.records.clear();
    }

    /**
     * List all loaded seed records.
     */
    list(): SeedRecord<T>[] {
        return Array.from(this.records.values());
    }

    /**
     * Get seed data only (without metadata).
     */
    listData(): T[] {
        return Array.from(this.records.values()).map(r => r.data);
    }

    /**
     * Get a specific record by name (filename without extension).
     */
    get(name: string): SeedRecord<T> | undefined {
        return this.records.get(name);
    }

    /**
     * Get seed data by name.
     */
    getData(name: string): T | undefined {
        return this.records.get(name)?.data;
    }

    /**
     * Refresh all records by reloading from disk.
     */
    protected async refresh(): Promise<void> {
        try {
            await fs.access(this.directory);
        } catch {
            logger.warn({ directory: this.directory }, '[SeedRegistry] Directory does not exist');
            return;
        }

        const files = await this.collectSeedFiles();
        const nextRecords = new Map<string, SeedRecord<T>>();

        for (const file of files) {
            try {
                const record = await this.loadSeedFile(file);
                nextRecords.set(record.name, record);
            } catch (error) {
                logger.warn({ err: error, file }, '[SeedRegistry] Failed to load seed file');
            }
        }

        this.records = nextRecords;
        logger.info(
            { directory: this.directory, count: this.records.size },
            '[SeedRegistry] Loaded seed files'
        );
    }

    /**
     * Collect all seed files from the directory.
     */
    protected async collectSeedFiles(): Promise<string[]> {
        const files: string[] = [];
        await this.collectFromDirectory(this.directory, files);
        return files.sort(); // Ensure consistent ordering
    }

    private async collectFromDirectory(dir: string, files: string[]): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.collectFromDirectory(fullPath, files);
            } else if (this.extensions.some(ext => entry.name.endsWith(ext))) {
                files.push(fullPath);
            }
        }
    }

    /**
     * Load and validate a single seed file.
     */
    protected async loadSeedFile(filePath: string): Promise<SeedRecord<T>> {
        const content = await fs.readFile(filePath, 'utf-8');
        const ext = path.extname(filePath).toLowerCase();
        const name = path.basename(filePath, ext);

        let rawData: unknown;
        if (ext === '.json') {
            rawData = JSON.parse(content);
        } else if (ext === '.yaml' || ext === '.yml') {
            rawData = yaml.parse(content);
        } else {
            throw new Error(`Unsupported file extension: ${ext}`);
        }

        const parsed = this.schema.parse(rawData);

        return {
            data: parsed,
            sourcePath: filePath,
            name,
        };
    }

    /**
     * Start watching for file changes (dev mode).
     */
    private async startWatcher(): Promise<void> {
        try {
            const chokidar = await import('chokidar');
            const watcher = chokidar.watch(this.directory, {
                ignoreInitial: true,
                persistent: false,
            });

            const refresh = async () => {
                try {
                    await this.refresh();
                } catch (error) {
                    logger.warn({ err: error }, '[SeedRegistry] Failed to refresh on file change');
                }
            };

            watcher.on('add', refresh);
            watcher.on('change', refresh);
            watcher.on('unlink', refresh);

            this.watcher = {
                close: () => watcher.close().catch(() => undefined),
            };
        } catch (error) {
            logger.debug({ err: error }, '[SeedRegistry] chokidar not available, watching disabled');
        }
    }
}

/**
 * Load a single JSON file of seed data (for array-based seeds like tiers, models).
 */
export async function loadSeedJson<T>(
    filePath: string,
    schema: ZodType<T[]>
): Promise<T[]> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const rawData = JSON.parse(content);
        return schema.parse(rawData);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.debug({ filePath }, '[loadSeedJson] File not found, returning empty array');
            return [];
        }
        throw error;
    }
}

/**
 * Load a single JSON seed document.
 */
export async function loadSeedJsonValue<T>(
    filePath: string,
    schema: ZodType<T>
): Promise<T | undefined> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const rawData = JSON.parse(content);
        return schema.parse(rawData);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.debug({ filePath }, '[loadSeedJsonValue] File not found');
            return undefined;
        }
        throw error;
    }
}

/**
 * Load a single YAML file of seed data.
 */
export async function loadSeedYaml<T>(
    filePath: string,
    schema: ZodType<T>
): Promise<T | undefined> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const rawData = yaml.parse(content);
        return schema.parse(rawData);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.debug({ filePath }, '[loadSeedYaml] File not found');
            return undefined;
        }
        throw error;
    }
}
