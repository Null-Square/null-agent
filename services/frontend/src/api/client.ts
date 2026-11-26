/**
 * Type-safe API client generated from OpenAPI spec
 * 
 * Usage:
 * 1. Start backend: npm run dev:backend
 * 2. Generate types: npm run generate:api
 * 3. Import and use:
 * 
 * import { api } from '@/api/client';
 * const { data } = await api.GET('/api/ai-agent/sessions');
 */

import createClient from 'openapi-fetch';
import type { paths } from './schema';
import { toastService } from '@shared/services/toastService';
import { metrics } from '@shared/lib/metrics';

const getBaseUrl = () => {
    // The app's own address: the dev server and nginx pass /api to the backend, so the owner
    // cookie rides along on every call.
    return import.meta.env.VITE_API_BASE_URL || '';
};

// Export base URL for SSE and other non-fetch use cases
export const apiBaseUrl = getBaseUrl().replace(/\/+$/, '');

// 429 is deliberately absent. The server is healthy and asking us to slow
// down, so retrying spends the next window's budget and makes the limit
// stickier. Worse, the retry sleeps on the server's Retry-After — the honest
// time until the window resets, up to a full minute — and React Query retries
// this whole wrapper again on top. Surface the 429 to the caller instead.
const RETRY_STATUSES = new Set([408, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 400;

const parseRetryAfter = (value: string | null): number | undefined => {
    if (!value) return undefined;
    const seconds = Number(value);
    if (!Number.isNaN(seconds) && seconds >= 0) {
        return seconds * 1000;
    }
    return undefined;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithRetry = async (requestFactory: () => Promise<Response>): Promise<Response> => {
    let attempt = 0;
    while (true) {
        metrics.apiTiming.start(`fetch-${attempt + 1}`);
        const response = await requestFactory();
        metrics.apiTiming.end(`fetch-${attempt + 1}`);
        if (!RETRY_STATUSES.has(response.status) || attempt >= MAX_RETRIES) {
            return response;
        }

        attempt += 1;
        const retryAfterMs =
            parseRetryAfter(response.headers.get('Retry-After')) ??
            BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(retryAfterMs);
    }
};

const buildRequest = (input: RequestInfo | URL, init: RequestInit | undefined) =>
    input instanceof Request ? input : new Request(input, init);

// Custom fetch wrapper that retries and handles errors
const appFetch: typeof fetch = async (input, init) => {
    const request = buildRequest(input, init);

    const response = await fetchWithRetry(() => fetch(request));
    await handleErrorResponse(response);
    return response;
};

// Handle 403/429 errors with toast notifications
const handleErrorResponse = async (response: Response) => {
    const status = response.status;
    if (status === 403 || status === 429) {
        try {
            const clonedResponse = response.clone();
            const data = await clonedResponse.json();
            const code = typeof data.code === 'string' ? data.code : undefined;
            const message =
                typeof data.message === 'string'
                    ? data.message
                    : typeof data.error === 'string'
                        ? data.error
                        : status === 403
                            ? 'This action is not allowed.'
                            : 'Rate limited. Please wait a moment.';
            toastService.warning(code ? `${code}` : status === 403 ? 'Not allowed' : 'Rate limited', message);
        } catch {
            // JSON parsing failed, show generic message
            toastService.warning('Request failed', 'An error occurred');
        }
    }
};

/**
 * Typed API client - all endpoints and responses are type-checked
 */
export const api = createClient<paths>({
    baseUrl: getBaseUrl(),
    headers: {
        'Content-Type': 'application/json',
    },
    fetch: appFetch,
});

export default api;
