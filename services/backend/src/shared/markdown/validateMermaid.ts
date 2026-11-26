import mermaid from 'mermaid';

export interface MermaidBlockError {
  blockIndex: number;
  startLine: number;
  errorLine: number | null;
  message: string;
  snippet: string;
}

export interface MermaidValidationResult {
  ok: boolean;
  blocks: number;
  errors: MermaidBlockError[];
}

interface MermaidFence {
  index: number;
  startLine: number;
  body: string;
}

const FENCE_PATTERN = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)\n\1\2[ \t]*$/gmu;

function extractFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  let match: RegExpExecArray | null;
  let index = 0;
  FENCE_PATTERN.lastIndex = 0;
  while ((match = FENCE_PATTERN.exec(markdown)) !== null) {
    const before = markdown.slice(0, match.index);
    const startLine = before.split('\n').length + 1;
    fences.push({ index: index++, startLine, body: match[3] ?? '' });
  }
  return fences;
}

function snippetAround(body: string, line: number | null): string {
  const lines = body.split('\n');
  const center = line && line >= 1 && line <= lines.length ? line - 1 : 0;
  const from = Math.max(0, center - 1);
  const to = Math.min(lines.length, center + 2);
  return lines.slice(from, to).join('\n');
}

interface MermaidParseError extends Error {
  hash?: { loc?: { first_line?: number } };
}

const DOMPURIFY_RUNTIME_ERROR = 'DOMPurify.addHook is not a function';
const FLOWCHART_DECLARATION_PATTERN = /^\s*(?:graph|flowchart)\b/im;
const FLOWCHART_SUBGRAPH_LABEL_PATTERN =
  /\b(subgraph\s+[A-Za-z][A-Za-z0-9_-]*)(?:\s*(?:\[[^\]\n]*\]|\("[^"\n]*"\)|\('[^'\n]*'\)|\([^)\n]*\)))?/g;
const FLOWCHART_NODE_LABEL_PATTERN =
  /\b([A-Za-z][A-Za-z0-9_-]*)(?:\[\[[^\]\n]*\]\]|\[\([^\]\n]*\)\]|\[\{[^\]\n]*\}\]|\[\/[^\]\n]*\/\]|\[\\[^\]\n]*\\\]|\[\/[^\]\n]*\\\]|\[\\[^\]\n]*\/\]|\[[^\]\n]*\]|\(\([^)\n]*\)\)|\([^)\n]*\)|\{\{[^}\n]*\}\}|\{[^}\n]*\}|>[^\]\n]*\])/g;
const FLOWCHART_SUBGRAPH_WRAPPER_LINE_PATTERN = /^[ \t]*(?:subgraph\b[^\n]*|end)[ \t]*(?:\n|$)/gmi;
const FLOWCHART_PIPE_EDGE_LABEL_PATTERN = /([-.=xo<>]*[-.=]+[xo<>]?[-.=]*>)\|[^|\n]*\|/g;
const FLOWCHART_TEXT_EDGE_LABEL_PATTERN = /--\s+[^-\n][^-]*?\s+-->/g;

function isMermaidParseError(value: unknown): value is MermaidParseError {
  return value instanceof Error;
}

function getErrorMessage(error: unknown): string {
  return isMermaidParseError(error) ? error.message : String(error);
}

function isDomPurifyRuntimeError(error: unknown): boolean {
  return getErrorMessage(error).includes(DOMPURIFY_RUNTIME_ERROR);
}

function stripFlowchartLabelsForSyntaxValidation(body: string): string {
  if (!FLOWCHART_DECLARATION_PATTERN.test(body)) {
    return body;
  }

  FLOWCHART_DECLARATION_PATTERN.lastIndex = 0;
  return body
    .replace(FLOWCHART_SUBGRAPH_LABEL_PATTERN, '$1')
    .replace(FLOWCHART_NODE_LABEL_PATTERN, '$1')
    .replace(FLOWCHART_PIPE_EDGE_LABEL_PATTERN, '$1')
    .replace(FLOWCHART_TEXT_EDGE_LABEL_PATTERN, '-->')
    .replace(FLOWCHART_SUBGRAPH_WRAPPER_LINE_PATTERN, '');
}

async function parseMermaidForValidation(body: string): Promise<void> {
  try {
    await mermaid.parse(body, { suppressErrors: false });
  } catch (error) {
    if (!isDomPurifyRuntimeError(error)) {
      throw error;
    }

    const syntaxOnlyBody = stripFlowchartLabelsForSyntaxValidation(body);
    if (syntaxOnlyBody === body) {
      throw error;
    }

    await mermaid.parse(syntaxOnlyBody, { suppressErrors: false });
  }
}

export async function validateMermaidInMarkdown(markdown: string): Promise<MermaidValidationResult> {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return { ok: true, blocks: 0, errors: [] };
  }
  const fences = extractFences(markdown);
  if (fences.length === 0) {
    return { ok: true, blocks: 0, errors: [] };
  }
  const errors: MermaidBlockError[] = [];
  for (const fence of fences) {
    try {
      await parseMermaidForValidation(fence.body);
    } catch (error) {
      const errorLine = isMermaidParseError(error) && typeof error.hash?.loc?.first_line === 'number'
        ? error.hash.loc.first_line
        : null;
      const message = getErrorMessage(error);
      errors.push({
        blockIndex: fence.index,
        startLine: fence.startLine,
        errorLine,
        message: message.split('\n')[0]?.slice(0, 400) ?? 'parse error',
        snippet: snippetAround(fence.body, errorLine),
      });
    }
  }
  return { ok: errors.length === 0, blocks: fences.length, errors };
}

export function formatMermaidErrors(result: MermaidValidationResult): string {
  if (result.ok) return '';
  return result.errors
    .map((e) => {
      const lineRef = e.errorLine !== null
        ? `block ${e.blockIndex + 1} (markdown line ${e.startLine + e.errorLine - 1}, diagram line ${e.errorLine})`
        : `block ${e.blockIndex + 1} (starting at markdown line ${e.startLine})`;
      return `${lineRef}: ${e.message}\n${e.snippet}`;
    })
    .join('\n\n');
}
