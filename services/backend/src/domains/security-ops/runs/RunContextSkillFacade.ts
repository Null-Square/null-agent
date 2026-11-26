import { logger } from '@/shared/logger';
import type { RunServiceSkillContextPort } from './RunContextService';

export class RunContextSkillFacade {
  constructor(private readonly skillContextService?: RunServiceSkillContextPort) {}

  async buildAssignedSkillsContext(
    orgId: string,
    scopeId: string,
    assignedSkillSlugs: readonly string[] | null | undefined,
  ): Promise<string> {
    try {
      if (!this.skillContextService) {
        return '';
      }
      const block = await this.skillContextService.buildAssignedSkillsContext(
        orgId,
        scopeId,
        assignedSkillSlugs ?? [],
      );
      return block.trim();
    } catch (error) {
      logger.warn(
        { err: error, orgId, scopeId, assignedSkillSlugs },
        '[runs] Failed to build assigned skills context',
      );
      return '';
    }
  }

  async buildPhaseCompatibleSkillCatalogContext(
    orgId: string,
    scopeId: string,
    phaseKey: Parameters<NonNullable<RunServiceSkillContextPort['buildPhaseCompatibleSkillCatalogContext']>>[2],
    assignedSkillSlugs: readonly string[] | null | undefined,
  ): Promise<string> {
    try {
      if (!this.skillContextService?.buildPhaseCompatibleSkillCatalogContext) {
        return '';
      }
      const block = await this.skillContextService.buildPhaseCompatibleSkillCatalogContext(
        orgId,
        scopeId,
        phaseKey,
        assignedSkillSlugs ?? [],
      );
      return block.trim();
    } catch (error) {
      logger.warn(
        { err: error, orgId, scopeId, phaseKey },
        '[runs] Failed to build phase-compatible skill catalog context',
      );
      return '';
    }
  }

}
