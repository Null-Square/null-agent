import * as fs from 'fs/promises';
import * as path from 'path';
import type { ZodType, ZodTypeDef } from 'zod';
import { logger } from '@/shared/logger';

type ModuleWithManifest<TManifest> = {
  manifest?: TManifest;
  default?: { manifest?: TManifest };
};

export interface ManifestRegistryOptions<TManifest> {
  directory: string;
  schema: ZodType<TManifest, ZodTypeDef, unknown>;
  extensions?: string[];
  devWatch?: boolean;
}

export class ManifestRegistry<TManifest extends { id: string }> {
  private readonly directory: string;
  protected readonly schema: ZodType<TManifest, ZodTypeDef, unknown>;
  private readonly extensions: string[];
  protected records: Map<string, TManifest> = new Map();
  private watcher?: { close: () => void };
  private readonly devWatch: boolean;

  constructor(options: ManifestRegistryOptions<TManifest>) {
    this.directory = options.directory;
    this.schema = options.schema;
    this.extensions = options.extensions ?? ['.ts', '.js', '.cjs', '.mjs'];
    this.devWatch = Boolean(options.devWatch);
  }

  async init(): Promise<void> {
    await this.refresh();
    if (this.devWatch) {
      await this.startWatcher();
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.records.clear();
  }

  list(): TManifest[] {
    return Array.from(this.records.values());
  }

  get(id: string): TManifest | undefined {
    return this.records.get(id);
  }

  protected async refresh(): Promise<void> {
    const files = await this.collectManifestFiles();
    const nextRecords = new Map<string, TManifest>();

    for (const file of files) {
      try {
        const manifest = await this.loadManifest(file);
        nextRecords.set(manifest.id, manifest);
      } catch (error) {
        logger.warn({ err: error, file }, 'Failed to load manifest');
      }
    }

    this.records = nextRecords;
  }

  protected async collectManifestFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(this.directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectFromDirectory(fullPath)));
      } else if (this.extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }

    return files.sort();
  }

  private async collectFromDirectory(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectFromDirectory(fullPath)));
      } else if (this.extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private async loadManifest(filePath: string): Promise<TManifest> {
    const resolvedPath = require.resolve(filePath);
    delete require.cache[resolvedPath];
    const module = require(resolvedPath) as ModuleWithManifest<TManifest>;
    const manifest = module.manifest ?? module.default?.manifest;

    if (!manifest) {
      throw new Error(`Manifest missing in module: ${filePath}`);
    }

    const parsed = this.schema.parse(manifest);
    return { ...parsed, id: parsed.id.trim() } as TManifest;
  }

  private async startWatcher(): Promise<void> {
    const watcher = (await import('chokidar')).watch(this.directory, {
      ignoreInitial: true,
      persistent: false,
    });

    const refresh = async () => {
      try {
        await this.refresh();
      } catch (error) {
        logger.warn({ err: error }, '[ManifestRegistry] Failed to refresh manifests');
      }
    };

    watcher.on('add', refresh);
    watcher.on('change', refresh);
    watcher.on('unlink', refresh);
    watcher.on('addDir', refresh);
    watcher.on('unlinkDir', refresh);

    this.watcher = {
      close: () => watcher.close().catch(() => undefined),
    };
  }
}
