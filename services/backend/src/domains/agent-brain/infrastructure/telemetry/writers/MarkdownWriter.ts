import * as fs from 'fs';
import * as path from 'path';

export interface MarkdownHeader {
  sessionId: string;
  createdAt: string;
  workspace: string;
  container?: { image?: string; id?: string };
  tools: string[];
}

export class MarkdownWriter {
  private readonly filePath: string;
  private stream: fs.WriteStream;
  private headerWritten = false;
  private closed = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  writeHeader(header: MarkdownHeader): void {
    if (this.headerWritten || this.closed || this.stream.writableEnded) return;
    const lines = [
      `# Session ${header.sessionId}`,
      `- **Created:** ${header.createdAt}`,
      `- **Workspace:** ${header.workspace}`,
      header.container?.image
        ? `- **Container:** ${header.container.image}${header.container?.id ? ` (id: ${header.container.id})` : ''}`
        : '- **Container:** host',
      header.tools.length ? `- **Tools:** ${header.tools.join(', ')}` : '- **Tools:** none',
      '',
      '---',
      '',
    ];
    this.stream.write(lines.join('\n') + '\n');
    this.headerWritten = true;
  }

  appendTurn(turn: number): void {
    if (this.closed || this.stream.writableEnded) return;
    this.stream.write(`\n## Turn ${turn}\n`);
  }

  appendEvent(line: string): void {
    if (this.closed || this.stream.writableEnded) return;
    this.stream.write(`${line}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
