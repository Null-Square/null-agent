import path from 'path';

/**
 * Shared utilities for file uploads across the application.
 * Used by both task file uploads and user action file uploads.
 */

/**
 * Sanitizes a filename by removing unsafe characters.
 * Preserves alphanumeric characters, dots, underscores, and hyphens.
 */
export const sanitizeFileName = (name: string): string => {
    const base = path.basename(name || 'upload.bin');
    return base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^\.+/, '') || 'upload.bin';
};

/**
 * Builds a relative path for uploaded files within the workspace.
 * Format: .uploads/<category>/<identifier>/<timestamp>-<filename>
 */
export const buildUploadPath = (
    category: string,
    identifier: string,
    originalName: string,
): string => {
    const safeCategory = category.replace(/[^a-zA-Z0-9._-]/g, '-');
    const safeIdentifier = identifier.replace(/[^a-zA-Z0-9._-]/g, '-');
    const safeName = sanitizeFileName(originalName);
    return path.posix.join('.uploads', safeCategory, safeIdentifier, `${Date.now()}-${safeName}`);
};

/**
 * Validates file size against a maximum limit.
 * Returns true if valid, false if too large.
 */
export const validateFileSize = (
    fileSize: number,
    maxSize: number | undefined,
    defaultMax: number = 10 * 1024 * 1024, // 10MB default
): boolean => {
    const limit = maxSize ?? defaultMax;
    return fileSize <= limit;
};

/**
 * Checks if a file matches an accept list (file extensions or MIME types).
 */
export const matchesAcceptList = (
    accept: string[] | undefined,
    originalName: string,
    mimeType: string = '',
): boolean => {
    if (!accept || accept.length === 0) {
        return true;
    }
    const lowered = accept.map((item) => item.toLowerCase());
    const mime = (mimeType || '').toLowerCase();

    return lowered.some((rule) => {
        if (rule.startsWith('.')) {
            return (originalName || '').toLowerCase().endsWith(rule);
        }
        if (rule.includes('/')) {
            return mime === rule;
        }
        return false;
    });
};

/**
 * Converts a relative upload path to a workspace path.
 */
export const toWorkspacePath = (relativePath: string): string => {
    return `/workspace/${relativePath}`;
};
