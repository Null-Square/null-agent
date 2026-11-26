import type { SandboxConfig } from './types';

export type ImageRequest = {
  image?: string;
  toolpack?: string;
};

export class ImageResolver {
  constructor(private readonly config: SandboxConfig) {}

  resolve(request?: ImageRequest): string {
    if (request?.image) {
      return request.image;
    }
    // Placeholder: toolpack resolution will be implemented in Phase SM.
    return this.config.image;
  }
}

