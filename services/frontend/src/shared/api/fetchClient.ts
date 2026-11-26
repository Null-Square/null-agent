/**
 * Fetch-based API client with axios-like interface.
 * Use for endpoints not yet in the OpenAPI spec.
 */

import { ApiError, parseApiError, type ApiErrorResponse } from '@shared/lib/apiError';

export const apiBaseUrl = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/+$/, '');

const safeJson = async (response: Response): Promise<unknown | null> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/**
 * Create a typed ApiError from response data.
 * Replaces `new Error(...) as any` pattern.
 */
function createApiError(response: Response, data: ApiErrorResponse | null): ApiError {
  return parseApiError({
    response: {
      status: response.status,
      data: data ?? { message: `Request failed: ${response.status}` },
    },
  });
}

// Axios-like response type
interface AxiosLikeResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
}

type JsonRequestBody = object;

// Create an axios-like API that uses native fetch
export const api = {
  async get<T = unknown>(
    url: string,
    config?: { params?: Record<string, unknown>; responseType?: 'blob' | 'json' }
  ): Promise<AxiosLikeResponse<T>> {
    let fullUrl = `${apiBaseUrl}/api${url}`;
    if (config?.params) {
      const searchParams = new URLSearchParams();
      Object.entries(config.params).forEach(([key, value]) => {
        if (value !== undefined) {
          searchParams.set(key, String(value));
        }
      });
      const qs = searchParams.toString();
      if (qs) fullUrl += `?${qs}`;
    }

    const response = await fetch(fullUrl, {
      method: 'GET',
    });

    let data: unknown;
    if (config?.responseType === 'blob') {
      data = await response.blob();
    } else {
      data = await safeJson(response);
    }

    if (!response.ok) {
      throw createApiError(response, data as ApiErrorResponse | null);
    }

    return { data: data as T, status: response.status, statusText: response.statusText };
  },

  async post<T = unknown>(
    url: string,
    body?: FormData | JsonRequestBody,
    config?: { headers?: Record<string, string>; baseURL?: string }
  ): Promise<AxiosLikeResponse<T>> {
    const baseURL = config?.baseURL || `${apiBaseUrl}/api`;
    const fullUrl = `${baseURL}${url}`;

    const isFormData = body instanceof FormData;
    const headers: HeadersInit = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...config?.headers,
    };

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: isFormData ? body : (body ? JSON.stringify(body) : undefined),
    });

    const data = await safeJson(response);

    if (!response.ok) {
      throw createApiError(response, data as ApiErrorResponse | null);
    }

    return { data: data as T, status: response.status, statusText: response.statusText };
  },

  async delete<T = unknown>(url: string): Promise<AxiosLikeResponse<T>> {
    const fullUrl = `${apiBaseUrl}/api${url}`;

    const response = await fetch(fullUrl, {
      method: 'DELETE',
    });

    const data = await safeJson(response);

    if (!response.ok) {
      throw createApiError(response, data as ApiErrorResponse | null);
    }

    return { data: data as T, status: response.status, statusText: response.statusText };
  },

  async put<T = unknown>(url: string, body?: JsonRequestBody): Promise<AxiosLikeResponse<T>> {
    const fullUrl = `${apiBaseUrl}/api${url}`;

    const response = await fetch(fullUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await safeJson(response);

    if (!response.ok) {
      throw createApiError(response, data as ApiErrorResponse | null);
    }

    return { data: data as T, status: response.status, statusText: response.statusText };
  },

  async patch<T = unknown>(url: string, body?: JsonRequestBody): Promise<AxiosLikeResponse<T>> {
    const fullUrl = `${apiBaseUrl}/api${url}`;

    const response = await fetch(fullUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await safeJson(response);

    if (!response.ok) {
      throw createApiError(response, data as ApiErrorResponse | null);
    }

    return { data: data as T, status: response.status, statusText: response.statusText };
  },
};

export default api;
