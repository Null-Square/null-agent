/**
 * LLMMessageLogger
 * 
 * Captures LLM messages on error for debugging.
 * Only logs last N turns to avoid excessive storage.
 * Redacts sensitive data (API keys, passwords, PII patterns).
 */

import type { SessionTraceRecorder } from './SessionTraceRecorder';
import { logger } from '@/shared/logger';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMMessageLoggerOptions {
  /** Number of turns to retain (default: 3) */
  turnsToRetain: number;
  /** Whether to log on success too (default: false - only on error) */
  logOnSuccess: boolean;
  /** Maximum content length before truncation */
  maxContentLength: number;
}

const DEFAULT_OPTIONS: LLMMessageLoggerOptions = {
  turnsToRetain: 3,
  logOnSuccess: false,
  maxContentLength: 4096,
};

// Patterns to redact
const REDACTION_PATTERNS = [
  // API keys
  /sk-[a-zA-Z0-9]{32,}/g,
  /api[_-]?key['":\s]*[a-zA-Z0-9_-]{20,}/gi,
  /bearer\s+[a-zA-Z0-9._-]+/gi,
  // Passwords
  /password['":\s]*[^\s'"]+/gi,
  /secret['":\s]*[^\s'"]+/gi,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // AWS keys
  /AKIA[0-9A-Z]{16}/g,
  // Connection strings
  /postgres:\/\/[^\s]+/gi,
  /mongodb:\/\/[^\s]+/gi,
  /redis:\/\/[^\s]+/gi,
];

export class LLMMessageLogger {
  private readonly options: LLMMessageLoggerOptions;
  private readonly log = logger.child({ scope: 'LLMMessageLogger' });
  
  // Ring buffer of recent messages per session
  private readonly messageBuffers: Map<string, ChatMessage[]> = new Map();

  constructor(options?: Partial<LLMMessageLoggerOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Record a message to the ring buffer
   */
  recordMessage(sessionId: string, message: ChatMessage): void {
    let buffer = this.messageBuffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.messageBuffers.set(sessionId, buffer);
    }
    
    // Add message
    buffer.push(message);
    
    // Trim to max turns (each turn = user + assistant, so 2 * turnsToRetain + 1 for system)
    const maxMessages = this.options.turnsToRetain * 2 + 1;
    if (buffer.length > maxMessages) {
      // Keep system message if it exists
      const hasSystem = buffer[0]?.role === 'system';
      if (hasSystem) {
        const system = buffer[0];
        buffer.splice(0, buffer.length - maxMessages + 1);
        buffer.unshift(system);
      } else {
        buffer.splice(0, buffer.length - maxMessages);
      }
    }
  }

  /**
   * Log messages on error for debugging
   */
  async logOnError(
    sessionId: string,
    turn: number,
    error: Error,
    recorder?: SessionTraceRecorder,
  ): Promise<void> {
    const buffer = this.messageBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) {
      return;
    }

    const redactedMessages = buffer.map((msg) => ({
      role: msg.role,
      content: this.redactContent(this.truncateContent(msg.content)),
      contentLength: msg.content.length,
      truncated: msg.content.length > this.options.maxContentLength,
    }));

    if (recorder) {
      try {
        await recorder.write(sessionId, turn, {
          event: 'llm.messages',
          severity: 'error',
          payload: {
            error: {
              message: error.message,
              name: error.name,
            },
            messageCount: redactedMessages.length,
            messages: redactedMessages,
          },
          note: `LLM error context: ${redactedMessages.length} messages`,
        });
      } catch (writeError) {
        this.log.warn({ err: writeError, sessionId }, 'Failed to write LLM messages to trace');
      }
    }

    this.log.debug(
      { sessionId, messageCount: redactedMessages.length },
      'Logged LLM messages on error',
    );
  }

  /**
   * Clean up buffer when session ends
   */
  clearSession(sessionId: string): void {
    this.messageBuffers.delete(sessionId);
  }

  /**
   * Redact sensitive content
   */
  private redactContent(content: string): string {
    let redacted = content;
    for (const pattern of REDACTION_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }

  /**
   * Truncate long content
   */
  private truncateContent(content: string): string {
    if (content.length <= this.options.maxContentLength) {
      return content;
    }
    const halfLength = Math.floor(this.options.maxContentLength / 2);
    return (
      content.slice(0, halfLength) +
      '\n...[TRUNCATED]...\n' +
      content.slice(-halfLength)
    );
  }
}

// Singleton instance
export const llmMessageLogger = new LLMMessageLogger();
