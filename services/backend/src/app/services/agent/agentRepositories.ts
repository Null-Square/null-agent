import { ArtifactRepository, MessageRepository, SessionRepository } from '@/domains/agent-brain/adapters/persistence';
import { PolicyConfigRepositoryAdapter } from '@/domains/agent-brain/adapters/PolicyConfigRepositoryAdapter';
import type { PolicyRepositoryPort } from '@/domains/agent-brain/ports';

export type AgentRepositories = {
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  artifactRepository: ArtifactRepository;
  policyRepository: PolicyRepositoryPort;
};

export const createAgentRepositories = (): AgentRepositories => {
  const sessionRepository = new SessionRepository();
  const messageRepository = new MessageRepository();
  const artifactRepository = new ArtifactRepository();
  let policyRepository: PolicyRepositoryPort | null = null;

  return {
    sessionRepository,
    messageRepository,
    artifactRepository,
    get policyRepository() {
      if (!policyRepository) {
        policyRepository = new PolicyConfigRepositoryAdapter();
      }
      return policyRepository;
    },
  };
};
