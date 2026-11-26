import type { ToolDefinition } from '../types';
import type { SessionState } from '../types';
import type { PromptSection } from './promptSections';

export type StaticPromptSectionContext = {
  basePrompt: string;
  tools: ToolDefinition[];
  sessionState?: SessionState;
};

export type SoftPromptSectionContext = {
  softContext?: string;
};

export type DynamicPromptSectionContext = {
  sessionState: SessionState;
};

type PromptSectionBuilder<TContext> = (context: TContext) => PromptSection | null;

export class PromptSectionRegistry {
  private readonly staticBuilders: PromptSectionBuilder<StaticPromptSectionContext>[] = [];
  private readonly softBuilders: PromptSectionBuilder<SoftPromptSectionContext>[] = [];
  private readonly dynamicBuilders: PromptSectionBuilder<DynamicPromptSectionContext>[] = [];

  registerStatic(builder: PromptSectionBuilder<StaticPromptSectionContext>): void {
    this.staticBuilders.push(builder);
  }

  registerSoft(builder: PromptSectionBuilder<SoftPromptSectionContext>): void {
    this.softBuilders.push(builder);
  }

  registerDynamic(builder: PromptSectionBuilder<DynamicPromptSectionContext>): void {
    this.dynamicBuilders.push(builder);
  }

  buildStatic(context: StaticPromptSectionContext): PromptSection[] {
    return this.staticBuilders
      .map((builder) => builder(context))
      .filter((section): section is PromptSection => section !== null);
  }

  buildSoft(context: SoftPromptSectionContext): PromptSection[] {
    return this.softBuilders
      .map((builder) => builder(context))
      .filter((section): section is PromptSection => section !== null);
  }

  buildDynamic(context: DynamicPromptSectionContext): PromptSection[] {
    return this.dynamicBuilders
      .map((builder) => builder(context))
      .filter((section): section is PromptSection => section !== null);
  }
}

const promptSectionRegistryInstance = new PromptSectionRegistry();

export const getPromptSectionRegistry = (): PromptSectionRegistry => promptSectionRegistryInstance;
