import { phaseProfileRegistry } from '@/domains/security-ops/runs/PhaseProfileRegistry';
import type { ToolAccessPolicy } from '@/domains/agent-brain/domain/types';

const GENERATED_HEADER = [
  '# Generated from PhaseProfileRegistry for admin catalog tool-policy surfacing.',
  '# Do not edit by hand. Run `npm run catalog:policies` from services/backend.',
].join('\n');

const POLICY_CONTEXT = {
  whiteboxEnabled: true,
  connectedRepoCount: 1,
};

export type GeneratedAgentCatalogPolicy = {
  slug: string;
  fileName: string;
  name: string;
  policy: ToolAccessPolicy;
};

const unique = (values: readonly string[]): string[] => Array.from(new Set(values));

const buildPhasePolicy = (
  phaseKey: Parameters<typeof phaseProfileRegistry.buildToolPolicy>[0],
): ToolAccessPolicy =>
  phaseProfileRegistry.buildToolPolicy(phaseKey, POLICY_CONTEXT);

const buildPhasePolicyEntry = (
  phaseKey: Parameters<typeof phaseProfileRegistry.buildToolPolicy>[0],
): GeneratedAgentCatalogPolicy => ({
  slug: `phase-${phaseKey}`,
  fileName: `phase-${phaseKey}.yaml`,
  name: `Agent Catalog Phase ${phaseKey}`,
  policy: buildPhasePolicy(phaseKey),
});

const buildUnionPolicy = (): ToolAccessPolicy => {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const profile of phaseProfileRegistry.list()) {
    if (profile.phaseKey === 'planning') continue;
    const policy = buildPhasePolicy(profile.phaseKey);
    allow.push(...(policy.allow ?? []));
    deny.push(...(policy.deny ?? []));
  }
  return {
    ...(allow.length > 0 ? { allow: unique(allow) } : {}),
    ...(deny.length > 0 ? { deny: unique(deny) } : {}),
  };
};

export const buildGeneratedAgentCatalogPolicies = (): GeneratedAgentCatalogPolicy[] => [
  {
    slug: 'agent-planner',
    fileName: 'agent-planner.yaml',
    name: 'Agent Catalog Planner',
    policy: buildPhasePolicy('planning'),
  },
  {
    slug: 'agent-executor',
    fileName: 'agent-executor.yaml',
    name: 'Agent Catalog Executor',
    policy: buildUnionPolicy(),
  },
  buildPhasePolicyEntry('recon'),
  buildPhasePolicyEntry('enumeration'),
  buildPhasePolicyEntry('validation'),
  buildPhasePolicyEntry('evidence'),
  buildPhasePolicyEntry('control_assessment'),
  buildPhasePolicyEntry('reporting'),
  buildPhasePolicyEntry('review_mapping'),
  buildPhasePolicyEntry('review_analysis'),
  buildPhasePolicyEntry('review_validation'),
  buildPhasePolicyEntry('review_reporting'),
];

const renderList = (label: string, values: readonly string[] | undefined): string[] => {
  if (!values || values.length === 0) return [];
  return [
    `    ${label}:`,
    ...values.map((value) => `      - ${value}`),
  ];
};

export const renderGeneratedAgentCatalogPolicy = (
  generated: GeneratedAgentCatalogPolicy,
): string => [
  GENERATED_HEADER,
  `slug: ${generated.slug}`,
  `name: ${generated.name}`,
  'isDefaultSandbox: false',
  'spec:',
  '  tools:',
  ...renderList('allow', generated.policy.allow),
  ...renderList('deny', generated.policy.deny),
  '',
].join('\n');
