// Shared API barrel.
// Canonical OpenAPI client (primary).
export { api, apiBaseUrl } from '../../api/client';
export type { paths } from '../../api/schema';

// Fetch-based API client (for endpoints not in the OpenAPI spec yet).
export { api as fetchApi } from './fetchClient';

// Fetch utilities (recommended for new code).
export {
  authenticatedFetch,
  authenticatedFormDataFetch,
  apiBaseUrl as fetchApiBaseUrl,
} from './authenticatedFetch';
