import { describe, expect, it } from 'vitest';
import { codeSourceName, describeCodeSource, shortCommit } from './codeSource';

describe('code source names', () => {
  it('names a git URL by its repository', () => {
    expect(codeSourceName({ location: 'https://github.com/juice-shop/juice-shop' })).toBe('juice-shop');
    expect(codeSourceName({ location: 'https://github.com/juice-shop/juice-shop.git/' })).toBe('juice-shop');
    expect(codeSourceName({ location: 'git@github.com:owner/repository.git' })).toBe('repository');
  });

  it('names a folder by its last part, on Windows and elsewhere', () => {
    expect(codeSourceName({ location: 'C:\\code\\juice-shop' })).toBe('juice-shop');
    expect(codeSourceName({ location: '/home/me/code/app/' })).toBe('app');
  });

  it('shows the short commit beside the name once one is known', () => {
    expect(shortCommit('3f9c2a1b8e')).toBe('3f9c2a1');
    expect(shortCommit(null)).toBeNull();
    expect(describeCodeSource({ location: 'https://github.com/a/juice-shop', headCommit: '3f9c2a1b8e' })).toBe(
      'juice-shop · 3f9c2a1',
    );
    expect(describeCodeSource({ location: 'https://github.com/a/juice-shop', headCommit: null })).toBe('juice-shop');
  });
});
