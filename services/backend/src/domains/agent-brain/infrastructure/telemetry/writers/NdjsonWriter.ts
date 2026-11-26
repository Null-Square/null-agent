import * as fs from 'fs';
import * as path from 'path';

export class NdjsonWriter {
  private readonly filePath: string;
  private stream: fs.WriteStream;
  private bytesWritten = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  append(record: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const buffer = Buffer.from(line, 'utf8');
    this.bytesWritten += buffer.length;

    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.stream.off('drain', onDrain);
        reject(error);
      };

      const onDrain = () => {
        this.stream.off('error', onError);
        resolve();
      };

      this.stream.once('error', onError);

      const ok = this.stream.write(buffer);
      if (!ok) {
        this.stream.once('drain', onDrain);
      } else {
        process.nextTick(onDrain);
      }
    });
  }

  getSize(): number {
    return this.bytesWritten;
  }

  async close(): Promise<void> {
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
