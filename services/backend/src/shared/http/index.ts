/**
 * Shared HTTP utilities
 */

export {
    type ApiErrorBody,
    createApiError,
    sendApiError,
    getStatusForCode,
    ApiErrors,
    apiErrorHandler,
    isApiError,
} from './apiError';
