import type { ScannerIngestor } from './types';

export class ScannerIngestorRegistry<TParser extends string, TParsed, TSummary, TContext = unknown> {
  private readonly ingestors: Partial<Record<TParser, ScannerIngestor<TParsed, TSummary, TContext>>>;

  constructor(ingestors: Partial<Record<TParser, ScannerIngestor<TParsed, TSummary, TContext>>>) {
    this.ingestors = { ...ingestors };
  }

  get(parser: TParser): ScannerIngestor<TParsed, TSummary, TContext> | undefined {
    return this.ingestors[parser];
  }

  has(parser: TParser): boolean {
    return this.ingestors[parser] !== undefined;
  }
}
