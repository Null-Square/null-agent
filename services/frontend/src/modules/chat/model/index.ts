// Chat module model/state re-exports (transient store, reducers, utils).
export {
  configureStore,
  useSelector,
} from '@modules/chat/store/store';
export {
  rootReducer,
  initialRootState,
} from '@modules/chat/store/rootReducer';
export type { RootAction, RootState } from '@modules/chat/store/types';
export { generateMessageId } from '@modules/chat/store/utils';
export { normalizeTaskSummary } from '@modules/chat/store/normalizers';
export { messageActions, sessionActions, configActions } from '@modules/chat/store/actions';
export {
  default as AIChatProvider,
  useAIChat,
  useAIChatContext,
} from './AIChatContext';
export type { AIChatContextType } from '@/types/chat';
