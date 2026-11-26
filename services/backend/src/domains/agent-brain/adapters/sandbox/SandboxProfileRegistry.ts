export type SandboxProfilesConfig = {
    sandboxProfiles: Record<string, string>;
};
import { logger } from '@/shared/logger';

export class SandboxProfileRegistry {
    constructor(private readonly config: SandboxProfilesConfig) { }
    private readonly log = logger.child({ scope: 'SandboxProfileRegistry' });

    resolveImage(profileKey?: string): string {
        if (!profileKey) {
            return this.config.sandboxProfiles.default;
        }

        const image = this.config.sandboxProfiles[profileKey];
        if (!image) {
            this.log.warn({ profileKey }, '[SandboxProfileRegistry] Profile not found, falling back to default');
            return this.config.sandboxProfiles.default;
        }

        return image;
    }

    getProfiles(): string[] {
        return Object.keys(this.config.sandboxProfiles);
    }
}
