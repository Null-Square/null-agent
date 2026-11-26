import * as path from 'path';
import { ManifestRegistry } from './ManifestRegistry';
import { toolManifestSchema, type ToolManifest } from '../../domain/manifests';
import type { ToolModuleDefinition, ToolModuleExport } from '../../application/tools/types';
import { logger } from '@/shared/logger';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const hasSkipManifestFlag = (value: unknown): value is { __skipToolManifest: true } =>
  isRecord(value) && value['__skipToolManifest'] === true;
const hasToolsArray = (value: unknown): value is { tools: ToolModuleDefinition[] } =>
  isRecord(value) && Array.isArray(value['tools']);

export interface ToolManifestRegistryOptions {
  directory: string;
  devWatch?: boolean;
  onUpdate?: (modules: ToolModuleDefinition[]) => void;
}

export class ToolManifestRegistry extends ManifestRegistry<ToolManifest> {
  private modules: Map<string, ToolModuleDefinition> = new Map();
  private cacheBuster = 0;
  private readonly onUpdate?: (modules: ToolModuleDefinition[]) => void;

  constructor(options: ToolManifestRegistryOptions) {
    super({
      directory: path.resolve(options.directory),
      schema: toolManifestSchema,
      devWatch: options.devWatch,
    });
    this.onUpdate = options.onUpdate;
  }

  getModule(id: string): ToolModuleDefinition | undefined {
    return this.modules.get(id);
  }

  listModules(): ToolModuleDefinition[] {
    return Array.from(this.modules.values());
  }

  override list(): ToolManifest[] {
    return Array.from(this.records.values());
  }

  protected override async refresh(): Promise<void> {
    const files = await this.collectManifestFiles();
    const manifestMap = new Map<string, ToolManifest>();
    const moduleMap = new Map<string, ToolModuleDefinition>();

    for (const file of files) {
      try {
        const moduleDefs = await this.importModule(file);
        if (moduleDefs.length === 0) {
          continue;
        }
        for (const definition of moduleDefs) {
          const sourcedDefinition = { ...definition, sourceFile: file };
          manifestMap.set(sourcedDefinition.manifest.id, sourcedDefinition.manifest);
          moduleMap.set(sourcedDefinition.manifest.id, sourcedDefinition);
        }
      } catch (error) {
        logger.warn({ err: error, file }, '[ToolManifestRegistry] Failed to load module');
      }
    }

    this.records = manifestMap;
    this.modules = moduleMap;
    this.cacheBuster += 1;
    this.onUpdate?.(Array.from(moduleMap.values()));
  }

  private async importModule(filePath: string): Promise<ToolModuleDefinition[]> {
    const resolvedPath = require.resolve(filePath);
    delete require.cache[resolvedPath];
    const exports = require(resolvedPath) as ToolModuleExport;

    if (hasSkipManifestFlag(exports)) {
      return [];
    }

    if (Array.isArray(exports)) {
      return exports;
    }
    if ('default' in exports) {
      const value = exports.default;
      if (Array.isArray(value)) {
        return value;
      }
      if (hasToolsArray(value)) {
        return value.tools;
      }
      if (isRecord(value) && 'manifest' in value) {
        return [value as ToolModuleDefinition];
      }
    }
    if (hasToolsArray(exports)) {
      return exports.tools;
    }
    if ('manifest' in exports) {
      return [exports as ToolModuleDefinition];
    }

    // The builtins tree contains implementation/helper modules beneath
    // manifest-bearing entry modules. They are valid scan inputs but are not
    // independent tool definitions.
    return [];
  }
}
