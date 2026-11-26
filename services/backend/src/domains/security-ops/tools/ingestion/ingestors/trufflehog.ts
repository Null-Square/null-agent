import type { ScannerIngestorParams, ScannerParsedInput } from '../types';
import { ingestGenericScannerFindings, type GenericScannerIngestorContext } from './genericScanner';

export const ingestTrufflehogArtifact = <TContext = unknown>(
  params: ScannerIngestorParams<ScannerParsedInput, TContext>,
  ctx: GenericScannerIngestorContext<TContext>,
) => ingestGenericScannerFindings({ ...params, parser: 'trufflehog' }, ctx);
