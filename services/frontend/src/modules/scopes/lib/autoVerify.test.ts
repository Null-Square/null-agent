import { afterEach, describe, expect, it } from 'vitest';
import { isScopeAutoVerifyEnabled } from './autoVerify';
import { registerScopeAutoVerifyOverrideReader } from './autoVerify';

let unregister: () => void = () => undefined;

describe('isScopeAutoVerifyEnabled', () => {
  afterEach(() => {
    unregister();
  });

  it('is opt-in and returns to normal verification when cleared', () => {
    expect(isScopeAutoVerifyEnabled()).toBe(false);
    let enabled = true;
    unregister = registerScopeAutoVerifyOverrideReader(() => enabled);
    expect(isScopeAutoVerifyEnabled()).toBe(true);
    enabled = false;
    expect(isScopeAutoVerifyEnabled()).toBe(false);
  });
});
