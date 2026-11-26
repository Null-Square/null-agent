import { sandboxImageService } from '@/domains/platform/sandbox/infrastructure/SandboxImageService';

export type SandboxImageAppService = typeof sandboxImageService;

export const sandboxImageAppService: SandboxImageAppService = sandboxImageService;
