import { describe, it, expect } from 'vitest';
import {
  hasXmlToolCalls,
  parseXmlToolCalls,
} from '@/domains/agent-brain/application/orchestration/parsing';

describe('XmlToolCallParser', () => {
  describe('hasXmlToolCalls', () => {
    it('returns true when text contains <function=...> pattern', () => {
      const text = 'Some text <function=shell_run><parameter=command>ls</parameter></function>';
      expect(hasXmlToolCalls(text)).toBe(true);
    });

    it('returns false when text has no XML tool calls', () => {
      const text = 'Just regular text without any tool calls';
      expect(hasXmlToolCalls(text)).toBe(false);
    });

    it('returns true for multiline XML tool calls', () => {
      const text = `
I'll run a command:
<function=shell_run>
<parameter=command>ls -la</parameter>
</function>
      `;
      expect(hasXmlToolCalls(text)).toBe(true);
    });

    it('handles case-insensitive function tags', () => {
      const text = '<FUNCTION=shell_run><parameter=command>ls</parameter></FUNCTION>';
      expect(hasXmlToolCalls(text)).toBe(true);
    });

    it('returns false for incomplete function tags', () => {
      const text = '<function=shell_run> without closing tag';
      expect(hasXmlToolCalls(text)).toBe(false);
    });
  });

  describe('parseXmlToolCalls', () => {
    it('parses a single tool call with one parameter', () => {
      const text = `
I'll check the directory:
<function=shell_run>
<parameter=command>ls -la</parameter>
</function>
      `;

      const result = parseXmlToolCalls(text);

      expect(result.hasXmlToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('shell_run');

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.command).toBe('ls -la');
    });

    it('parses multiple parameters', () => {
      const text = `
<function=file_write>
<parameter=path>test.txt</parameter>
<parameter=content>Hello World</parameter>
</function>
      `;

      const result = parseXmlToolCalls(text);

      expect(result.hasXmlToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(1);

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.path).toBe('test.txt');
      expect(args.content).toBe('Hello World');
    });

    it('parses multiple tool calls', () => {
      const text = `
First, list directory:
<function=shell_run>
<parameter=command>ls</parameter>
</function>

Then read a file:
<function=file_read>
<parameter=path>README.md</parameter>
</function>
      `;

      const result = parseXmlToolCalls(text);

      expect(result.hasXmlToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].function.name).toBe('shell_run');
      expect(result.toolCalls[1].function.name).toBe('file_read');
    });

    it('removes tool call XML from cleanedText', () => {
      const text = 'Before <function=test_tool><parameter=x>1</parameter></function> After';

      const result = parseXmlToolCalls(text);

      expect(result.cleanedText).toBe('Before  After');
      expect(result.cleanedText).not.toContain('<function');
      expect(result.cleanedText).not.toContain('</function>');
    });

    it('parses JSON values in parameters', () => {
      const text = `
<function=test_tool>
<parameter=enabled>true</parameter>
<parameter=count>42</parameter>
<parameter=items>["a", "b", "c"]</parameter>
</function>
      `;

      const result = parseXmlToolCalls(text);

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.enabled).toBe(true);
      expect(args.count).toBe(42);
      expect(args.items).toEqual(['a', 'b', 'c']);
    });

    it('handles multiline parameter content', () => {
      const text = `
<function=file_write>
<parameter=path>script.sh</parameter>
<parameter=content>#!/bin/bash
echo "Hello"
echo "World"
</parameter>
</function>
      `;

      const result = parseXmlToolCalls(text);

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.content).toContain('#!/bin/bash');
      expect(args.content).toContain('echo "Hello"');
      expect(args.content).toContain('echo "World"');
    });

    it('returns empty toolCalls for text without XML tool calls', () => {
      const text = 'Just regular text';

      const result = parseXmlToolCalls(text);

      expect(result.hasXmlToolCalls).toBe(false);
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanedText).toBe('Just regular text');
    });

    it('generates unique IDs for each tool call', () => {
      const text = `
<function=tool1><parameter=x>1</parameter></function>
<function=tool2><parameter=y>2</parameter></function>
      `;

      const result = parseXmlToolCalls(text);

      const id1 = result.toolCalls[0].id;
      const id2 = result.toolCalls[1].id;

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id1.startsWith('xmlcall_')).toBe(true);
    });

    it('handles alternative <tool_call> format', () => {
      const text = `
<tool_call>
<name>web_search</name>
<arguments>{"query": "test search"}</arguments>
</tool_call>
      `;

      const result = parseXmlToolCalls(text);

      expect(result.hasXmlToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('web_search');

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.query).toBe('test search');
    });

    it('handles empty parameter content', () => {
      const text = `
<function=test_tool>
<parameter=empty></parameter>
<parameter=filled>value</parameter>
</function>
      `;

      const result = parseXmlToolCalls(text);

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.empty).toBe('');
      expect(args.filled).toBe('value');
    });

    it('preserves non-JSON strings as-is', () => {
      const text = `
<function=shell_run>
<parameter=command>echo "Not {valid} JSON"</parameter>
</function>
      `;

      const result = parseXmlToolCalls(text);

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.command).toBe('echo "Not {valid} JSON"');
    });
  });

  describe('real-world Qwen model output', () => {
    it('parses typical Qwen tool call format', () => {
      const qwenOutput = `I'll check the MX records for nullsquare.net:

<function=shell_run>
<parameter=command>
dig MX nullsquare.net
</parameter>
</function>`;

      const result = parseXmlToolCalls(qwenOutput);

      expect(result.hasXmlToolCalls).toBe(true);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].function.name).toBe('shell_run');

      const args = JSON.parse(result.toolCalls[0].function.arguments);
      expect(args.command.trim()).toBe('dig MX nullsquare.net');
      expect(result.cleanedText).toContain("I'll check the MX records");
      expect(result.cleanedText).not.toContain('<function');
    });

    it('parses multiple Qwen tool calls in sequence', () => {
      const qwenOutput = `Let me perform reconnaissance:

<function=shell_run>
<parameter=command>nslookup nullsquare.net</parameter>
</function>

<function=shell_run>
<parameter=command>whois nullsquare.net</parameter>
</function>`;

      const result = parseXmlToolCalls(qwenOutput);

      expect(result.toolCalls).toHaveLength(2);

      const args1 = JSON.parse(result.toolCalls[0].function.arguments);
      const args2 = JSON.parse(result.toolCalls[1].function.arguments);

      expect(args1.command).toBe('nslookup nullsquare.net');
      expect(args2.command).toBe('whois nullsquare.net');
    });
  });
});
