/**
 * Development shortcuts are controlled only by the runtime environment. There
 * is intentionally no feature flag that can accidentally expose them.
 */
export const isDevOnlyFeatureEnabled = (): boolean => {
  const environment = process.env.NODE_ENV?.toLowerCase();
  return environment === 'development' || environment === 'test';
};
