/**
 * S3 URI utilities.
 * 
 * Previously duplicated in sessions.router.ts, sessions.admin.router.ts, and ArtifactService.ts.
 * 
 * @example
 * import { parseS3Uri, isS3Uri, buildS3Uri } from '@/shared/storage/s3Utils';
 */

export interface S3UriParts {
  bucket: string;
  key: string;
}

/**
 * Parse an S3 URI into bucket and key components.
 * 
 * @param uri - S3 URI in format "s3://bucket/path/to/object"
 * @returns Parsed bucket and key, or null if invalid format
 * 
 * @example
 * parseS3Uri('s3://my-bucket/some/key.txt')
 * // => { bucket: 'my-bucket', key: 'some/key.txt' }
 */
export function parseS3Uri(uri: string): S3UriParts | null {
  if (!uri || typeof uri !== 'string') return null;
  
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  
  return { bucket: match[1], key: match[2] };
}

/**
 * Check if a string is an S3 URI.
 */
export function isS3Uri(uri: string | undefined | null): uri is string {
  if (!uri) return false;
  return uri.startsWith('s3://');
}

/**
 * Build an S3 URI from bucket and key.
 * 
 * @param bucket - S3 bucket name
 * @param key - Object key (path)
 * @returns S3 URI string
 */
export function buildS3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}
