import * as path from 'path';

/**
 * Normalize and validate a file path to ensure it's within the workspace directory
 */
export function normalizeAndValidatePath(filePath: string, workspaceDir: string): string {
  // Resolve the path relative to the workspace
  const resolvedPath = path.resolve(workspaceDir, filePath);
  
  // Normalize the path to resolve any '..' components
  const normalizedPath = path.normalize(resolvedPath);
  
  // Ensure the normalized path is within the workspace directory
  const workspaceDirNormalized = path.normalize(workspaceDir);
  
  // Check if the resolved path starts with the workspace directory
  if (!normalizedPath.startsWith(workspaceDirNormalized)) {
    throw new Error(`Security: Path ${filePath} resolves outside workspace directory. Access denied.`);
  }
  
  // Check for null bytes, which could be used maliciously
  if (filePath.includes('\0')) {
    throw new Error('Security: Path contains null bytes. Access denied.');
  }
  
  // Check for common attempts to escape the directory
  if (filePath.includes('..') && !filePath.includes('..\\') && !filePath.includes('../')) {
    // Additional check for directory traversal attempts
    const pathSegments = normalizedPath.split(path.sep);
    const workspaceSegments = workspaceDirNormalized.split(path.sep);
    
    // If the normalized path has fewer segments than workspace, it's definitely outside
    if (pathSegments.length < workspaceSegments.length) {
      throw new Error(`Security: Path ${filePath} resolves outside workspace directory. Access denied.`);
    }
    
    // Check that the first segments match the workspace path
    for (let i = 0; i < workspaceSegments.length; i++) {
      if (pathSegments[i] !== workspaceSegments[i]) {
        throw new Error(`Security: Path ${filePath} resolves outside workspace directory. Access denied.`);
      }
    }
  }
  
  return normalizedPath;
}

/**
 * Validate a command to prevent common security issues
 */
export function validateShellCommand(command: string): string | null {
  // Check for null bytes
  if (command.includes('\0')) {
    return 'Security: Command contains null bytes. Execution denied.';
  }
  
  // Newlines are allowed to support multi-line scripts/commands in the sandbox.

  // NOTE (Jan 2026): Removed $(), backtick, and heredoc blocks.
  // Model runs in isolated Docker sandbox - shell scripting is allowed.

  return null; // Command is valid
}
