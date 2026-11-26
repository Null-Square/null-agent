/**
 * Artifact DTOs - API Response Types
 *
 * These types replace `any` usage in adaptArtifactRow() and related handlers.
 */

// =============================================================================
// Database Row Types (from ArtifactRepository)
// =============================================================================

/**
 * Artifact row as returned from ArtifactRepository.
 * Note: Database returns null for absent values, not undefined.
 */
export interface ArtifactRowDTO {
  id: string;
  filePath: string;
  originalName: string;
  fileType?: string | null;
  sizeBytes?: number | string | null;
  createdAt?: Date | number | null;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Artifact detail for session responses.
 */
export interface ArtifactDetailDTO {
  id: string;
  filePath: string;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  createdAt: number;
  storage: 'local' | 's3';
  bucket?: string;
  downloadUrl?: string;
}
