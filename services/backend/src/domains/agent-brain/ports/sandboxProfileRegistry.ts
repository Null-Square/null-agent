export interface SandboxProfileRegistryPort {
  resolveImage(profileKey?: string): string;
  getProfiles(): string[];
}
