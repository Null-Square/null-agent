import { describe, it, expect } from 'vitest';
import { translateRequest, type OpenAIRequestBody } from '@/domains/agent-brain/adapters/providers/anthropic/requestTranslator';

describe('requestTranslator', () => {
  describe('system message extraction', () => {
    it('extracts system messages into top-level system param', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = translateRequest(body);
      expect(result.system).toEqual([
        { type: 'text', text: 'You are a helpful assistant.' },
      ]);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
    });

    it('extracts system messages with content blocks and cache_control', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'Static prompt', cache_control: { type: 'ephemeral' } },
              { type: 'text', text: 'Dynamic prompt' },
            ],
          },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = translateRequest(body);
      expect(result.system).toHaveLength(2);
      expect((result.system![0] as any).cache_control).toEqual({ type: 'ephemeral' });
      expect((result.system![1] as any).cache_control).toBeUndefined();
    });

    it('handles multiple system messages', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'system', content: 'First system' },
          { role: 'system', content: 'Second system' },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = translateRequest(body);
      expect(result.system).toHaveLength(2);
      expect(result.system![0].text).toBe('First system');
      expect(result.system![1].text).toBe('Second system');
    });

    it('omits system param when no system messages', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = translateRequest(body);
      expect(result.system).toBeUndefined();
    });
  });

  describe('message conversion', () => {
    it('converts simple user/assistant messages', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
      };

      const result = translateRequest(body);
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(result.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] });
      expect(result.messages[2]).toEqual({ role: 'user', content: 'How are you?' });
    });

    it('converts assistant tool_calls to tool_use blocks', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Search for cats' },
          {
            role: 'assistant',
            content: 'I will search for that.',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"cats"}' },
              },
            ],
          },
        ],
      };

      const result = translateRequest(body);
      const assistantContent = result.messages[1].content as any[];
      expect(assistantContent).toHaveLength(2);
      expect(assistantContent[0]).toEqual({ type: 'text', text: 'I will search for that.' });
      expect(assistantContent[1]).toEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'web_search',
        input: { query: 'cats' },
      });
    });

    it('converts tool result messages into user messages with tool_result blocks', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Do something' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result here' },
        ],
      };

      const result = translateRequest(body);
      // tool result should be inside a user message
      const toolMsg = result.messages[2];
      expect(toolMsg.role).toBe('user');
      const content = toolMsg.content as any[];
      expect(content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'Result here',
      });
    });

    it('merges consecutive tool results into same user message', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Do things' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result 1' },
          { role: 'tool', tool_call_id: 'call_2', content: 'Result 2' },
        ],
      };

      const result = translateRequest(body);
      // Both tool results should be merged into a single user message
      const userMsg = result.messages[2];
      expect(userMsg.role).toBe('user');
      const content = userMsg.content as any[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe('tool_result');
      expect(content[1].type).toBe('tool_result');
    });
  });

  describe('ensureToolResultCoverage (orphaned tool_use recovery)', () => {
    it('injects placeholder when tool_use has no following tool_result', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Do something' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_orphan', type: 'function', function: { name: 'search', arguments: '{}' } },
            ],
          },
          // No tool result — simulates the sanitizeToolOrdering drop bug
          { role: 'user', content: 'Next turn input' },
        ],
      };

      const result = translateRequest(body);

      // Should have 3 messages: user, assistant, user(placeholder+text)
      expect(result.messages).toHaveLength(3);
      const userMsg = result.messages[2];
      expect(userMsg.role).toBe('user');
      const content = userMsg.content as any[];
      const toolResult = content.find((b: any) => b.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult.tool_use_id).toBe('call_orphan');
      expect(JSON.parse(toolResult.content)).toMatchObject({
        schema: 'interrupted-tool-result/v1',
        recovered: true,
        outcome: { kind: 'outcome_unknown', guidance: 'verify_before_retry' },
      });
      expect(toolResult.content).not.toContain('Please retry the action');
    });

    it('injects placeholder when no following message exists at all', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Do something' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_alone', type: 'function', function: { name: 'search', arguments: '{}' } },
            ],
          },
          // No tool result, no next message
        ],
      };

      const result = translateRequest(body);

      expect(result.messages).toHaveLength(3);
      const injected = result.messages[2];
      expect(injected.role).toBe('user');
      const content = injected.content as any[];
      expect(content[0].type).toBe('tool_result');
      expect(content[0].tool_use_id).toBe('call_alone');
    });

    it('injects only missing placeholders when some tool_results are present', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Do things' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_ok', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'call_missing', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_ok', content: 'Result A' },
          // call_missing has no result
          { role: 'user', content: 'Continue' },
        ],
      };

      const result = translateRequest(body);

      // Find the user message after the assistant
      const afterAssistant = result.messages[2];
      expect(afterAssistant.role).toBe('user');
      const content = afterAssistant.content as any[];
      const toolResults = content.filter((b: any) => b.type === 'tool_result');
      // call_ok result + injected placeholder for call_missing
      expect(toolResults).toHaveLength(2);
      const okResult = toolResults.find((b: any) => b.tool_use_id === 'call_ok');
      const missingResult = toolResults.find((b: any) => b.tool_use_id === 'call_missing');
      expect(okResult.content).toBe('Result A');
      expect(JSON.parse(missingResult.content)).toMatchObject({
        recovered: true,
        outcome: { kind: 'outcome_unknown', guidance: 'verify_before_retry' },
      });
    });

    it('keeps exactly one matching result when duplicate tool results reach the last mile', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Do something' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_duplicate', type: 'function', function: { name: 'search', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_duplicate', content: 'first' },
          { role: 'tool', tool_call_id: 'call_duplicate', content: 'second' },
        ],
      };

      const result = translateRequest(body);
      const toolResults = (result.messages[2]!.content as any[]).filter(
        (block: any) => block.type === 'tool_result' && block.tool_use_id === 'call_duplicate',
      );
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].content).toBe('first');
    });

    it('does not modify messages when all tool_use blocks have tool_results', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [
          { role: 'user', content: 'Do things' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Result 1' },
          { role: 'tool', tool_call_id: 'call_2', content: 'Result 2' },
        ],
      };

      const result = translateRequest(body);
      const userMsg = result.messages[2];
      const content = userMsg.content as any[];
      const toolResults = content.filter((b: any) => b.type === 'tool_result');
      // Only the real results, no injected placeholders
      expect(toolResults).toHaveLength(2);
      // Real results have plain string content, not a JSON payload with recovered:true
      expect(toolResults[0].content).toBe('Result 1');
      expect(toolResults[1].content).toBe('Result 2');
    });
  });

  describe('tool definitions', () => {
    it('translates OpenAI tool definitions to Anthropic format', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get current weather',
              parameters: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'City name' },
                },
                required: ['location'],
              },
            },
          },
        ],
      };

      const result = translateRequest(body);
      expect(result.tools).toHaveLength(1);
      expect(result.tools![0]).toEqual({
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
          },
          required: ['location'],
        },
        cache_control: { type: 'ephemeral' },
      });
    });

    it('marks only the final tool as the tool-definition cache breakpoint', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'first_tool',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function',
            function: {
              name: 'second_tool',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      };

      const result = translateRequest(body);

      expect((result.tools![0] as any).cache_control).toBeUndefined();
      expect((result.tools![1] as any).cache_control).toEqual({ type: 'ephemeral' });
    });

    it('omits tools param when none provided', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = translateRequest(body);
      expect(result.tools).toBeUndefined();
    });
  });

  describe('request params', () => {
    it('sets default max_tokens when not specified', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = translateRequest(body);
      expect(result.max_tokens).toBe(4096);
    });

    it('preserves explicit max_tokens', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 2048,
      };

      const result = translateRequest(body);
      expect(result.max_tokens).toBe(2048);
    });

    it('passes through temperature, top_p, and stop', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        top_p: 0.9,
        stop: ['STOP', 'END'],
      };

      const result = translateRequest(body);
      expect(result.temperature).toBe(0.7);
      expect(result.top_p).toBe(0.9);
      expect(result.stop_sequences).toEqual(['STOP', 'END']);
    });

    it('passes through top-level automatic cache_control', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        cache_control: { type: 'ephemeral' },
      };

      const result = translateRequest(body);
      expect(result.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('wraps single stop string in array', () => {
      const body: OpenAIRequestBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        stop: 'STOP',
      };

      const result = translateRequest(body);
      expect(result.stop_sequences).toEqual(['STOP']);
    });
  });
});
