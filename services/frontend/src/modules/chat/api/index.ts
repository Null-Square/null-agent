// Chat module API surface (hooks/services) - re-exporting existing implementations.
export { useChatStreaming } from '@modules/chat/hooks/useChatStreaming';
export { useSessionActions } from '@modules/sessions';
export { useSessionLifecycle } from '@modules/chat/hooks/useSessionLifecycle';
export { useDerivedSessionTitle } from '@modules/chat/hooks/useDerivedSessionTitle';
export { useStarterPrompt } from '@modules/chat/hooks/useStarterPrompt';
export { useStreamCoalescer } from '@modules/chat/hooks/useStreamCoalescer';
export {
  assistantChatSessionsQueryKey,
  useAssistantChatSessionsQuery,
  useCreateScopedChatSessionMutation,
  useDeleteAssistantChatSessionMutation,
  useRenameAssistantChatSessionMutation,
} from './chatSessions';
export {
  setupReadinessQueryKey,
  uploadScopeDocument,
  useDismissSetupRecommendationMutation,
  useSetupReadinessQuery,
  type SetupRecommendationSurface,
  type SetupReadinessAction,
  type SetupReadinessState,
  type ScopeDocumentKind,
  type ScopeDocumentSummary,
} from './setup';
