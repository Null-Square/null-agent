/** Development shortcuts are removed from production builds with no override lever. */
export const isDevOnlyFeatureEnabled = (): boolean => Boolean(import.meta.env.DEV);
