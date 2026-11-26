import type { PromptBuilderPort, PromptBuildInput, PromptBuild } from '../../../ports';
import {
  SystemPromptBuilder,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  renderPromptSections,
} from '../../../domain/prompts';
import { resolvePromptProfile } from '@/config/agentPrompts';

export class PromptComposer implements PromptBuilderPort {
  build(input: PromptBuildInput): PromptBuild {
    const promptProfile = resolvePromptProfile(input.agentType, input.promptProfile ?? input.session.promptProfile);
    const staticSections = SystemPromptBuilder.buildStaticSections(promptProfile.prompt, input.tools, input.session);
    const softSections = SystemPromptBuilder.buildSoftSections(input.softContext);
    const dynamicSections = SystemPromptBuilder.buildDynamicSections(input.session);

    const staticPrompt = renderPromptSections(staticSections);
    const softContext = renderPromptSections(softSections);
    const dynamicPrompt = renderPromptSections(dynamicSections);
    const cacheablePrefix = [staticPrompt, softContext, SYSTEM_PROMPT_DYNAMIC_BOUNDARY]
      .filter(Boolean)
      .join('\n\n');

    return {
      staticPrompt,
      dynamicPrompt,
      cacheablePrefix,
      dynamicBoundary: SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      sections: {
        static: staticSections,
        soft: softSections,
        dynamic: dynamicSections,
      },
      agentType: input.agentType,
      promptProfile: promptProfile.profile,
      softContext,
    };
  }
}
