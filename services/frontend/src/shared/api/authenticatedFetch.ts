/**
 * App Fetch Wrapper
 * 
 * Centralized fetch utility that:
 * 1. Parses JSON responses
 * 2. Throws ApiError with backend's actual error message
 *
 * No Authorization header: the backend answers every request as the local owner.
 * 
 * This solves the problem of module APIs discarding backend error details.
 */

import { parseApiError } from '@shared/lib/apiError';

export const apiBaseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/+$/, '');

/**
 * Authenticated JSON fetch wrapper
 * 
 * @example
 * ```typescript
 * const data = await authenticatedFetch<{ schedules: Schedule[] }>('/api/ai-agent/schedules');
 * ```
 */
export async function authenticatedFetch<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const fullUrl = url.startsWith('http') ? url : `${apiBaseUrl}${url}`;

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options?.headers,
  };

  const response = await fetch(fullUrl, {
    ...options,
    headers,
  });

  // Parse response body
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;

  if (!response.ok) {
    throw parseApiError({ response: { status: response.status, data } });
  }

  return data as T;
}

/**
 * Authenticated FormData fetch wrapper (for file uploads)
 * 
 * @example
 * ```typescript
 * const formData = new FormData();
 * formData.append('file', file);
 * const result = await authenticatedFormDataFetch('/api/upload', formData);
 * ```
 */
export async function authenticatedFormDataFetch<T>(
  url: string,
  formData: FormData,
  options?: Omit<RequestInit, 'body' | 'headers'> & {
    headers?: Record<string, string>;
  }
): Promise<T> {
  const fullUrl = url.startsWith('http') ? url : `${apiBaseUrl}${url}`;

  // Don't set Content-Type for FormData - browser will set it with boundary
  const headers: HeadersInit = {
    ...options?.headers,
  };

  const response = await fetch(fullUrl, {
    method: 'POST',
    ...options,
    headers,
    body: formData,
  });

  const data = await response.json().catch(() => ({})) as Record<string, unknown>;

  if (!response.ok) {
    throw parseApiError({ response: { status: response.status, data } });
  }

  return data as T;
}

export default authenticatedFetch;
