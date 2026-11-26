/**
 * OpenAPI Index - Exports generated spec and registers all paths
 */

// Import registry first
export { registry, generateOpenAPIDocument } from './registry';

// Import all path registrations (side effects - registers paths)
import './paths/sessions';
import './paths/health';
import './paths/auth';
import './paths/profile';
import './paths/stream';
import './paths/tools';
import './paths/notifications';
import './paths/runs';
import './paths/scopes';
import './paths/findings';
import './paths/context-setup';
import './paths/model';

// Export schemas for external use
export * from './schemas';
