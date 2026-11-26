import { useSyncExternalStore } from 'react';
import type { RootState, RootAction } from './types';

type Listener = () => void;

class InMemoryStore<State> {
  private state: State;
  private readonly listeners: Set<Listener> = new Set();

  constructor(initialState: State) {
    this.state = initialState;
  }

  getState(): State {
    return this.state;
  }

  setState(updater: (previous: State) => State): void {
    this.state = updater(this.state);
    this.listeners.forEach((listener) => listener());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export type StoreApi = {
  getState: () => RootState;
  subscribe: (listener: Listener) => () => void;
};

export type Dispatch = (action: RootAction) => void;

export const configureStore = (
  initialState: RootState,
  reducer: (state: RootState, action: RootAction) => RootState
) => {
  const store = new InMemoryStore(initialState);
  const api: StoreApi = {
    getState: store.getState.bind(store),
    subscribe: store.subscribe.bind(store),
  };
  const dispatch: Dispatch = (action) => {
    store.setState((previous) => reducer(previous, action));
  };

  return { store: api, dispatch };
};

export const useSelector = <Selected>(
  store: StoreApi,
  selector: (state: RootState) => Selected
): Selected =>
  useSyncExternalStore(
    store.subscribe.bind(store),
    () => selector(store.getState()),
    () => selector(store.getState())
  );
