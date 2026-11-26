/**
 * Application Layer
 * 
 * Application services including SessionStore, StreamBroker, and CheckpointManager.
 * 
 * @module agent-brain/application
 */

// Core application services (organized in core/ subdirectory)
export * from './core';

// Application subdirectories (not re-exported to avoid conflicts)
// Import directly from ./commands, ./history, ./pipeline, ./services, ./orchestration

