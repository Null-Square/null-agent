import type { SessionState } from '../../domain/types';
import type { ArtifactServicePort } from '../../ports';

export class SessionSummaryService {
    constructor(private readonly artifactService?: ArtifactServicePort) { }

    async generateSummary(session: SessionState): Promise<string | null> {
        const artifactService = this.artifactService;
        if (artifactService) {
            const content = await artifactService.getArtifactContent(session.id, 'summary.md');
            if (content) {
                return content;
            }
        }

        if (session.summary) {
            return session.summary;
        }

        return null;
    }
}
