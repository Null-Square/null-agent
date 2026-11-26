import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    id?: string;
  }
}

export const requestId: RequestHandler = (req, _res, next) => {
  const header = req.header('x-request-id');
  req.id = typeof header === 'string' && header.trim() ? header.trim() : randomUUID();
  next();
};

