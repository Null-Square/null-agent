/**
 * XmlToolCallParser - Parses XML-style tool calls from model text output
 * 
 * Many cheap/open-source models (Qwen, Llama variants, Deepseek, Mistral)
 * output tool calls in XML format instead of using native function calling.
 * 
 * This parser detects and extracts tool calls from patterns like:
 * ```
 * <function=shell_run>
 * <parameter=command>ls -la</parameter>
 * </function>
 * ```
 * 
 * Design principles:
 * 1. Zero overhead for models that use native tool calls
 * 2. Automatic fallback detection
 * 3. Clean integration - parsed tools use same format as native calls
 */

import type { StreamToolCall } from '../../../ports';
import { v4 as uuidv4 } from 'uuid';

export interface ParseResult {
  hasXmlToolCalls: boolean;
  toolCalls: StreamToolCall[];
  cleanedText: string; // Text with XML tool calls removed
}

/**
 * Check if text contains XML-style tool calls
 */
export function hasXmlToolCalls(text: string): boolean {
  // Pattern: <function=tool_name> ... </function>
  return /<function=[\w_]+>[\s\S]*?<\/function>/i.test(text);
}

/**
 * Parse XML-style tool calls from model text output
 * 
 * Supports formats:
 * - <function=name><parameter=key>value</parameter></function>
 * - <tool_call><name>tool_name</name><arguments>...</arguments></tool_call>
 * 
 * @param text - The raw text output from the model
 * @returns ParseResult with extracted tool calls and cleaned text
 */
export function parseXmlToolCalls(text: string): ParseResult {
  const toolCalls: StreamToolCall[] = [];
  let cleanedText = text;

  // Pattern 1: <function=name><parameter=key>value</parameter></function>
  // This is the most common format from Qwen models
  const functionPattern = /<function=([\w_]+)>([\s\S]*?)<\/function>/gi;
  let match: RegExpExecArray | null;

  while ((match = functionPattern.exec(text)) !== null) {
    const [fullMatch, functionName, content] = match;
    
    // Parse parameters from content
    const args: Record<string, unknown> = {};
    const paramPattern = /<parameter=([\w_]+)>([\s\S]*?)<\/parameter>/gi;
    let paramMatch: RegExpExecArray | null;
    
    while ((paramMatch = paramPattern.exec(content)) !== null) {
      const [, paramName, paramValue] = paramMatch;
      // Try to parse as JSON, fall back to string
      try {
        args[paramName] = JSON.parse(paramValue.trim());
      } catch {
        args[paramName] = paramValue.trim();
      }
    }

    toolCalls.push({
      id: `xmlcall_${uuidv4().split('-')[0]}`,
      function: {
        name: functionName,
        arguments: JSON.stringify(args),
      },
    });

    // Remove the matched tool call from cleaned text
    cleanedText = cleanedText.replace(fullMatch, '');
  }

  // Pattern 2: <tool_call><name>...</name><arguments>...</arguments></tool_call>
  // Alternative format some models use
  const toolCallPattern = /<tool_call>\s*<name>([\w_]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/gi;
  
  while ((match = toolCallPattern.exec(text)) !== null) {
    const [fullMatch, functionName, argsContent] = match;
    
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsContent.trim());
    } catch {
      // If not valid JSON, treat as single argument
      args = { input: argsContent.trim() };
    }

    toolCalls.push({
      id: `xmlcall_${uuidv4().split('-')[0]}`,
      function: {
        name: functionName,
        arguments: JSON.stringify(args),
      },
    });

    cleanedText = cleanedText.replace(fullMatch, '');
  }

  // Clean up extra whitespace from removed tool calls
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

  return {
    hasXmlToolCalls: toolCalls.length > 0,
    toolCalls,
    cleanedText,
  };
}
