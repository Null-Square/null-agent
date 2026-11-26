import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { parse as parseYaml } from 'yaml';

import { resolveEvidencePath } from '@/domains/security-ops/tools/evidence/EvidenceResolver';
import type { ScannerParsedInput, ScannerResolvedArtifact } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class ScannerArtifactIO<TParser extends string = string> {
  async discoverScannerArtifactPath(
    workspaceDir: string,
    parser: TParser,
  ): Promise<ScannerResolvedArtifact> {
    const scanRoot = path.resolve(workspaceDir, '.artifacts', 'scans');
    const stat = await fs.stat(scanRoot).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(
        `No scanner artifact path was provided and .artifacts/scans does not exist. ` +
          `Write ${parser} output under /workspace/.artifacts/scans/ or pass artifactPath explicitly.`,
      );
    }

    const files: string[] = [];
    const walk = async (current: string): Promise<void> => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        files.push(path.relative(workspaceDir, absolute).replace(/\\/g, '/'));
      }
    };
    await walk(scanRoot);

    if (files.length === 0) {
      throw new Error(
        `No scanner artifact path was provided and .artifacts/scans is empty. ` +
          `Write ${parser} output under /workspace/.artifacts/scans/ or pass artifactPath explicitly.`,
      );
    }

    const parserName = parser.toLowerCase();
    const score = (relativePath: string): number => {
      const normalized = relativePath.toLowerCase();
      const base = path.posix.basename(normalized);
      if (normalized.startsWith(`.artifacts/scans/${parserName}/`)) return 0;
      if (base.startsWith(parserName)) return 1;
      if (base.includes(parserName) || normalized.includes(`/${parserName}/`)) return 2;
      return 3;
    };
    const sorted = files
      .map((relativePath) => ({ relativePath, score: score(relativePath) }))
      .sort((left, right) => left.score - right.score || left.relativePath.localeCompare(right.relativePath));
    const bestScore = sorted[0]?.score ?? 3;
    const candidates = sorted.filter((entry) => entry.score === bestScore);
    if (bestScore === 3 && files.length !== 1) {
      throw new Error(
        `No artifactPath was provided and .artifacts/scans has multiple files without a clear ${parser} match: ` +
          `${files.slice(0, 10).join(', ')}. Pass artifactPath explicitly.`,
      );
    }
    if (candidates.length !== 1) {
      throw new Error(
        `No artifactPath was provided and .artifacts/scans has multiple ${parser} candidates: ` +
          `${candidates.slice(0, 10).map((entry) => entry.relativePath).join(', ')}. Pass artifactPath explicitly.`,
      );
    }

    return this.resolveScannerArtifactPath(workspaceDir, {
      parser,
      artifactPath: candidates[0]!.relativePath,
    });
  }

  async resolveScannerArtifactPath(
    workspaceDir: string,
    parsed: Pick<ScannerParsedInput<TParser>, 'parser' | 'artifactPath'>,
  ): Promise<ScannerResolvedArtifact> {
    const artifactPath = parsed.artifactPath;
    if (!artifactPath) {
      return this.discoverScannerArtifactPath(workspaceDir, parsed.parser);
    }
    const resolved = resolveEvidencePath(artifactPath, workspaceDir);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved.absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error(
          `Artifact not found at ${resolved.relativePath}. ` +
            `If you ran the scanner with shell_run, pass the stdoutPath returned by wait_for_shell_job ` +
            `(typically .artifacts/shell-jobs/<jobId>/stdout.log). ` +
            `If you wrote the scanner output to a -o file, verify the file exists with shell_run before retrying.`,
        );
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw new Error(`Artifact path is not a file: ${artifactPath}`);
    }
    return resolved;
  }

  async forEachArtifactLine(
    artifact: ScannerResolvedArtifact,
    onLine: (line: string, lineNumber: number) => Promise<void>,
  ): Promise<void> {
    const stream = createReadStream(artifact.absolutePath, { encoding: 'utf8' });
    const reader = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    try {
      for await (const rawLine of reader) {
        lineNumber += 1;
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        await onLine(line, lineNumber);
      }
    } finally {
      reader.close();
      stream.close();
    }
  }

  async readOpenApiDocument(artifact: ScannerResolvedArtifact): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(artifact.absolutePath, 'utf8');
    const trimmed = raw.trim();
    const parsed = trimmed.startsWith('{') || trimmed.startsWith('[')
      ? JSON.parse(trimmed)
      : parseYaml(trimmed);
    if (!isRecord(parsed)) {
      throw new Error('OpenAPI artifact must parse to an object.');
    }
    return parsed;
  }

  async readArtifactJson(artifact: ScannerResolvedArtifact): Promise<unknown> {
    const raw = await fs.readFile(artifact.absolutePath, 'utf8');
    return JSON.parse(raw);
  }

  async readArtifactJsonLines(artifact: ScannerResolvedArtifact): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    await this.forEachArtifactLine(artifact, async (line) => {
      if (!line.startsWith('{')) {
        return;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed)) {
          rows.push(parsed);
        }
      } catch {
        // Keep ingestion row-tolerant; scanner JSONL often contains warnings or partial lines.
      }
    });
    return rows;
  }
}
