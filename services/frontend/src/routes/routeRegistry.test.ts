import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeRegistry } from './routeRegistry';

const routesDir = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(routesDir, 'routeRegistry.tsx');
const registrySource = fs.readFileSync(registryPath, 'utf8');

const routeFiles = fs
  .readdirSync(routesDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
  .map((entry) => entry.name)
  .filter((name) => !name.endsWith('.stories.tsx'))
  .filter((name) => !name.endsWith('.test.tsx') && !name.endsWith('.spec.tsx'))
  .filter((name) => name !== 'routeRegistry.tsx');

const routeNames = routeFiles.map((name) => path.basename(name, '.tsx'));
const registryImports = new Set(
  Array.from(registrySource.matchAll(/@\/routes\/([A-Za-z0-9_-]+)/g)).map((match) => match[1]),
);

describe('routeRegistry', () => {
  it('references every route wrapper file', () => {
    const missing = routeNames.filter((name) => !registryImports.has(name));
    expect(missing, `Missing route registry entries for: ${missing.join(', ')}`).toEqual([]);
  });

  it('only references existing route wrappers', () => {
    const wrapperSet = new Set(routeNames);
    const unknown = [...registryImports].filter((name) => !wrapperSet.has(name));
    expect(unknown, `Registry references missing route wrapper files: ${unknown.join(', ')}`).toEqual([]);
  });

  it('registers the credentials route and no integrations route (it only held NullSquare-hosted OAuth apps)', () => {
    expect(routeRegistry.some((route) => route.path === '/credentials')).toBe(true);
    expect(routeRegistry.some((route) => route.path === '/integrations')).toBe(false);
  });

  it('keeps the chat route but not as a nav destination', () => {
    // The route renders a conversation; the assistant panel is what opens it.
    const chatRoute = routeRegistry.find((route) => route.path === '/chat');
    expect(chatRoute).toBeTruthy();
    expect(chatRoute?.nav).toBeFalsy();
  });

  it('does not register a standalone Code Review launcher route', () => {
    expect(routeRegistry.some((route) => route.path === '/code-review')).toBe(false);
  });

  it('registers no sign-in, billing, Watch, invitation, profile or demo routes', () => {
    const saasPaths = [
      '/auth',
      '/login',
      '/auth/callback',
      '/forgot-password',
      '/reset-password',
      '/verify-email',
      '/check-email',
      '/scan/preview',
      '/pricing',
      '/checkout/success',
      '/checkout/cancelled',
      '/checkout/paddle',
      '/welcome',
      '/watch',
      '/integrations/github/complete',
      '/integrations/connected-sites/authorize',
      '/integrations/identity/complete',
      '/verified/:domain',
      '/invite/:token',
      '/profile',
    ];
    for (const saasPath of saasPaths) {
      expect(routeRegistry.some((route) => route.path === saasPath), saasPath).toBe(false);
    }
    expect(routeRegistry.some((route) => route.path.startsWith('/watch'))).toBe(false);
    expect(routeRegistry.some((route) => route.path.startsWith('/demo'))).toBe(false);
  });

  it('keeps every route except not-found behind the owner guard', () => {
    expect(routeRegistry.filter((route) => route.public).map((route) => route.id)).toEqual(['not-found']);
  });
});
