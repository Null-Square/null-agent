import type { RequestHandler } from 'express';

type CorsOptions = {
  origin?: string | string[] | ((origin: string | undefined) => boolean);
  allowCredentials?: boolean;
  methods?: string[];
  headers?: string[];
};

const defaultMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export const cors = ({
  origin = '*',
  allowCredentials = false,
  methods = defaultMethods,
  headers = [],
}: CorsOptions = {}): RequestHandler => {
  return (req, res, next) => {
    const requestOrigin = req.header('origin') || '';
    let allowedOrigin = '';

    if (typeof origin === 'function') {
      if (origin(requestOrigin)) {
        allowedOrigin = requestOrigin;
      }
    } else if (Array.isArray(origin)) {
      if (origin.includes(requestOrigin)) {
        allowedOrigin = requestOrigin;
      }
    } else {
      allowedOrigin = origin;
    }

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      if (allowCredentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    const requestedHeaders = req.header('access-control-request-headers');
    if (requestedHeaders) {
      res.setHeader('Access-Control-Allow-Headers', requestedHeaders);
    } else if (headers.length > 0) {
      res.setHeader('Access-Control-Allow-Headers', headers.join(', '));
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
};

