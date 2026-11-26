import type { NextFunction, Request, Response } from 'express';

import { localSettings } from '@/config/configSchema';

/**
 * The app's only door. Null AI has no sign-in, and its agent runs commands, so it answers only this
 * computer:
 *
 * - the request's Host must be this computer, which keeps a web page from reaching the app through a
 *   name that points at 127.0.0.1 (DNS rebinding) and keeps the app off your network;
 * - a request a browser sends from a page (it carries `Origin`) must come from a page on this computer,
 *   so a site you visit cannot post to the app (cross-site request forgery).
 *
 * Anything else is refused before any route sees it. Add host names with NULL_AI_ALLOWED_HOSTS
 * (comma-separated, no ports).
 */
const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'];

const parseHost = (header: string | undefined): string | null => {
  if (!header) return null;
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : null;
  }
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
};

const originHost = (origin: string): string | null => {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
};

export const allowedHosts = (env: NodeJS.ProcessEnv = process.env): Set<string> =>
  new Set([...DEFAULT_HOSTS, ...localSettings(env).NULL_AI_ALLOWED_HOSTS]);

export const createLocalHostOnly = (hosts: Set<string> = allowedHosts()) => {
  const isLocal = (host: string | null): boolean =>
    Boolean(host && (hosts.has(host) || host.endsWith('.localhost')));

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const fromLocalPage = origin === undefined || isLocal(originHost(origin));
    if (isLocal(parseHost(req.headers.host)) && fromLocalPage) {
      next();
      return;
    }
    res.status(403).json({
      error: {
        code: 'HOST_NOT_ALLOWED',
        message: 'Null AI answers only on this computer. Open it at http://localhost, or add this host to NULL_AI_ALLOWED_HOSTS.',
      },
    });
  };
};
