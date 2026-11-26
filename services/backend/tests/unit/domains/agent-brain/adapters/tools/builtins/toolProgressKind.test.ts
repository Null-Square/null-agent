import { describe, expect, it } from 'vitest';

import {
  IngestScanArtifact,
  PromoteFinding,
  ReportAsset,
  ReportFinding,
  ReportNote,
  ReportService,
  SubmitValidationLeadOutcome,
  SubmitValidationOutcome,
} from '@/domains/agent-brain/adapters/tools/builtins/securityops';
import {
  SubmitPhaseCheckpoint,
  SubmitPhaseHandoff,
} from '@/domains/agent-brain/adapters/tools/builtins/phase';
import { BrowserAction } from '@/domains/agent-brain/adapters/tools/builtins/browser_action';
import { HttpDifferential } from '@/domains/agent-brain/adapters/tools/builtins/http_differential';
import { HttpPayload, HttpRawSend } from '@/domains/agent-brain/adapters/tools/builtins/browser';
import { PythonSession } from '@/domains/agent-brain/adapters/tools/builtins/python';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';

const canonicalProgressTools = [
  IngestScanArtifact,
  PromoteFinding,
  ReportAsset,
  ReportFinding,
  ReportNote,
  ReportService,
  SubmitPhaseCheckpoint,
  SubmitPhaseHandoff,
  SubmitValidationLeadOutcome,
  SubmitValidationOutcome,
] satisfies ToolImpl[];

const evidenceProgressTools = [
  BrowserAction,
  HttpDifferential,
  HttpPayload,
  HttpRawSend,
  PythonSession,
] satisfies ToolImpl[];

const toolNames = (tools: ToolImpl[]): string[] => tools.map((tool) => tool.meta.name).sort();

describe('builtin tool progress metadata', () => {
  it('marks canonical write tools explicitly', () => {
    expect(toolNames(canonicalProgressTools)).toEqual([
      'ingest_scan_artifact',
      'promote_finding',
      'report_asset',
      'report_finding',
      'report_note',
      'report_service',
      'submit_phase_checkpoint',
      'submit_phase_handoff',
      'submit_validation_lead_outcome',
      'submit_validation_outcome',
    ]);

    for (const tool of canonicalProgressTools) {
      expect(tool.meta.progressKind).toBe('canonical');
    }
  });

  it('marks evidence-gathering tools explicitly', () => {
    expect(toolNames(evidenceProgressTools)).toEqual([
      'browser_action',
      'http_differential',
      'http_payload',
      'http_raw_send',
      'python_session',
    ]);

    for (const tool of evidenceProgressTools) {
      expect(tool.meta.progressKind).toBe('evidence');
    }
  });

  it('carries progress metadata into generated manifests', () => {
    expect(fromToolImpl(ReportFinding).manifest.meta.progressKind).toBe('canonical');
    expect(fromToolImpl(HttpPayload).manifest.meta.progressKind).toBe('evidence');
    expect(fromToolImpl(HttpRawSend).manifest.meta.progressKind).toBe('evidence');
    expect(fromToolImpl(PythonSession).manifest.meta.progressKind).toBe('evidence');
  });
});
