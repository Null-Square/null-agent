/**
 * SandboxImageService - in-memory registry seeded from sandbox config.
 *
 * DB-backed sandbox_images table was removed from baseline schema.
 */

import { loadSandboxProfilesConfig } from '@/config/sandboxProfilesConfig';

export type SandboxImageRow = {
  id: string;
  name: string;
  imageTag: string;
  description: string | null;
  isDefault: boolean;
  dockerProfileId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NewSandboxImageRow = {
  id?: string;
  name: string;
  imageTag: string;
  description?: string | null;
  isDefault?: boolean;
  dockerProfileId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const buildId = (name: string): string => `sandbox-image:${name}`;

export class SandboxImageService {
  private rows = new Map<string, SandboxImageRow>();
  private initialized = false;

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const now = new Date();
    const config = await loadSandboxProfilesConfig();
    for (const [name, imageTag] of Object.entries(config.profiles)) {
      const row: SandboxImageRow = {
        id: buildId(name),
        name,
        imageTag,
        description: null,
        isDefault: name === config.defaultProfile,
        dockerProfileId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(row.id, row);
    }

    this.initialized = true;
  }

  async list(): Promise<SandboxImageRow[]> {
    await this.ensureInitialized();
    return [...this.rows.values()].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  }

  async getById(id: string): Promise<SandboxImageRow | undefined> {
    await this.ensureInitialized();
    return this.rows.get(id);
  }

  async getByName(name: string): Promise<SandboxImageRow | undefined> {
    await this.ensureInitialized();
    return [...this.rows.values()].find((row) => row.name === name);
  }

  async getDefault(): Promise<SandboxImageRow | undefined> {
    await this.ensureInitialized();
    return [...this.rows.values()].find((row) => row.isDefault);
  }

  async getImageTag(name: string): Promise<string | undefined> {
    const image = await this.getByName(name);
    return image?.imageTag;
  }

  async getDefaultImageTag(): Promise<string | undefined> {
    const image = await this.getDefault();
    return image?.imageTag;
  }

  async create(data: NewSandboxImageRow): Promise<SandboxImageRow> {
    await this.ensureInitialized();
    const now = new Date();

    if (data.isDefault) {
      for (const [id, row] of this.rows) {
        this.rows.set(id, { ...row, isDefault: false, updatedAt: now });
      }
    }

    const row: SandboxImageRow = {
      id: data.id ?? buildId(data.name),
      name: data.name,
      imageTag: data.imageTag,
      description: data.description ?? null,
      isDefault: data.isDefault ?? false,
      dockerProfileId: data.dockerProfileId ?? null,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };

    this.rows.set(row.id, row);
    return row;
  }

  async update(
    id: string,
    data: Partial<NewSandboxImageRow>,
  ): Promise<SandboxImageRow | undefined> {
    await this.ensureInitialized();
    const existing = this.rows.get(id);
    if (!existing) {
      return undefined;
    }

    const now = new Date();
    if (data.isDefault) {
      for (const [otherId, row] of this.rows) {
        this.rows.set(otherId, { ...row, isDefault: false, updatedAt: now });
      }
    }

    const updated: SandboxImageRow = {
      ...existing,
      name: data.name ?? existing.name,
      imageTag: data.imageTag ?? existing.imageTag,
      description:
        data.description === undefined ? existing.description : data.description,
      isDefault: data.isDefault ?? existing.isDefault,
      dockerProfileId:
        data.dockerProfileId === undefined
          ? existing.dockerProfileId
          : data.dockerProfileId,
      updatedAt: now,
    };
    this.rows.set(id, updated);
    return updated;
  }

  async setDefault(id: string): Promise<SandboxImageRow | undefined> {
    await this.ensureInitialized();
    const row = this.rows.get(id);
    if (!row) {
      return undefined;
    }

    const now = new Date();
    for (const [otherId, existing] of this.rows) {
      this.rows.set(otherId, {
        ...existing,
        isDefault: otherId === id,
        updatedAt: now,
      });
    }
    return this.rows.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.ensureInitialized();
    this.rows.delete(id);
  }

  async upsertByName(data: NewSandboxImageRow): Promise<SandboxImageRow> {
    await this.ensureInitialized();
    const existing = await this.getByName(data.name);
    if (existing) {
      const updated = await this.update(existing.id, data);
      return updated!;
    }
    return this.create(data);
  }
}

export const sandboxImageService = new SandboxImageService();
