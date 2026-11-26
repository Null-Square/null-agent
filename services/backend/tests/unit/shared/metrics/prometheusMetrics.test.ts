import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * Tests for Prometheus metrics (prom-client)
 * 
 * Verifies that metrics are correctly recorded and exported.
 */

// Jest globals are auto-injected, no import needed
import {
  registry,
  turnCommitLatency,
  toolExecLatency,
  llmRequestLatency,
  sandboxLifecycleLatency,
  turnCommitTotal,
  toolExecTotal,
  apiErrorTotal,
  recordTurnCommit,
  recordToolExec,
  recordLLMRequest,
  recordSandboxLifecycle,
  recordAPIError,
  recordCreditMissingOrganization,
  recordCloudRunAdmission,
  recordCloudRunRecovery,
  recordCloudCapacitySnapshot,
} from '@/shared/metrics/prometheusMetrics';

describe('Prometheus Metrics', () => {
  beforeEach(async () => {
    // Reset all metrics before each test
    registry.resetMetrics();
  });

  describe('recordTurnCommit', () => {
    it('records successful turn commit', async () => {
      recordTurnCommit(1500, true);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('turn_commit_latency_ms_bucket');
      expect(metrics).toContain('turn_commit_total{status="success"');
    });

    it('records failed turn commit', async () => {
      recordTurnCommit(500, false);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('turn_commit_total{status="error"');
    });

    it('increments counter correctly', async () => {
      recordTurnCommit(100, true);
      recordTurnCommit(200, true);
      recordTurnCommit(300, false);
      
      const metrics = await registry.metrics();
      
      // Should have 2 successes and 1 error
      expect(metrics).toMatch(/turn_commit_total\{status="success".*\} 2/);
      expect(metrics).toMatch(/turn_commit_total\{status="error".*\} 1/);
    });
  });

  describe('recordToolExec', () => {
    it('records tool execution with name label', async () => {
      recordToolExec('shell_run', 450, true);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('tool_exec_latency_ms_bucket');
      expect(metrics).toContain('tool="shell_run"');
      expect(metrics).toContain('status="ok"');
    });

    it('tracks different tools separately', async () => {
      recordToolExec('shell_run', 100, true);
      recordToolExec('file_write', 50, true);
      recordToolExec('shell_run', 200, false);
      
      const metrics = await registry.metrics();
      
      // shell_run: 1 ok, 1 error
      expect(metrics).toMatch(/tool_exec_total\{tool="shell_run",status="ok".*\} 1/);
      expect(metrics).toMatch(/tool_exec_total\{tool="shell_run",status="error".*\} 1/);
      // file_write: 1 ok
      expect(metrics).toMatch(/tool_exec_total\{tool="file_write",status="ok".*\} 1/);
    });
  });

  describe('recordLLMRequest', () => {
    it('records LLM request with provider and model labels', async () => {
      recordLLMRequest('qwen', 'qwen3-max', 2500, 200);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('llm_request_latency_ms_bucket');
      expect(metrics).toContain('provider="qwen"');
      expect(metrics).toContain('model="qwen3-max"');
      expect(metrics).toContain('status_class="2xx"');
    });

    it('categorizes status codes correctly', async () => {
      recordLLMRequest('openai', 'gpt-4', 1000, 200);
      recordLLMRequest('openai', 'gpt-4', 500, 429);
      recordLLMRequest('openai', 'gpt-4', 100, 500);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('status_class="2xx"');
      expect(metrics).toContain('status_class="4xx"');
      expect(metrics).toContain('status_class="5xx"');
    });
  });

  describe('recordSandboxLifecycle', () => {
    it('records provision operations', async () => {
      recordSandboxLifecycle('provision', 3000, true);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('sandbox_lifecycle_latency_ms_bucket');
      expect(metrics).toContain('operation="provision"');
      expect(metrics).toContain('status="ok"');
    });

    it('records destroy operations', async () => {
      recordSandboxLifecycle('destroy', 500, true);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('operation="destroy"');
    });
  });

  describe('recordAPIError', () => {
    it('records API errors with category and provider', async () => {
      recordAPIError('rate_limit', 'openai');
      recordAPIError('timeout', 'qwen');
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('api_error_total');
      expect(metrics).toContain('category="rate_limit"');
      expect(metrics).toContain('provider="openai"');
      expect(metrics).toContain('category="timeout"');
      expect(metrics).toContain('provider="qwen"');
    });
  });

  describe('cloud Run scheduling metrics', () => {
    it('exports only bounded queue, admission, capacity, and recovery labels', async () => {
      recordCloudRunAdmission('pro', 'started', 125);
      recordCloudRunRecovery('requeued', 2);
      recordCloudCapacitySnapshot({
        automaticAdmission: true,
        starvationThresholdMs: 900_000,
        queue: {
          depth: 2,
          oldestWaitMs: 30_000,
          byClass: { free: 1, paid: 1, pro: 0, internal: 0 },
        },
        runners: [{
          name: 'cloud-primary',
          schedulingMode: 'accepting',
          heartbeatStale: false,
          automaticCapacityReady: true,
          lastHeartbeatAt: new Date().toISOString(),
          detectedMemoryMb: 2048,
          admissionMemoryMb: 2048,
          leasedMemoryMb: 1024,
          detectedContainerSlots: 2,
          leasedContainerSlots: 1,
          derivedActiveRuns: 1,
          leasedActiveRuns: 1,
          cleanupDisagreements: 0,
        }],
      });

      const output = await registry.metrics();
      expect(output).toContain('cloud_run_admission_total{scheduling_class="pro",result="started"');
      expect(output).toContain('cloud_run_recovery_total{result="requeued"');
      expect(output).toMatch(/cloud_run_queue_depth\{scheduling_class="free"[^}]*\} 1/);
      expect(output).toMatch(/cloud_run_capacity\{runner="cloud-primary",resource="active_runs",kind="limit"[^}]*\} 1/);
      expect(output).toMatch(/cloud_run_runner_ready\{runner="cloud-primary"[^}]*\} 1/);
      expect(output).toMatch(/cloud_run_ready_runners(?:\{[^}]*\})? 1/);
      expect(output).toMatch(/cloud_run_automatic_admission(?:\{[^}]*\})? 1/);
      expect(output).not.toContain('run_id=');
      expect(output).not.toContain('organization_id=');
    });
  });

  describe('recordCreditMissingOrganization', () => {
    it('records missing organization credit scope by source', async () => {
      recordCreditMissingOrganization('credit_gate');
      recordCreditMissingOrganization('usage_recorder');

      const metrics = await registry.metrics();

      expect(metrics).toContain('credit_missing_organization_total');
      expect(metrics).toContain('source="credit_gate"');
      expect(metrics).toContain('source="usage_recorder"');
    });
  });

  describe('histogram buckets', () => {
    it('turn commit latency has correct buckets for typical turn durations', async () => {
      // Simulate various turn durations
      recordTurnCommit(50, true);    // Fast
      recordTurnCommit(500, true);   // Normal
      recordTurnCommit(5000, true);  // Slow
      recordTurnCommit(15000, true); // Very slow
      
      const metrics = await registry.metrics();
      
      // Should have buckets for different latencies
      expect(metrics).toContain('le="100"');
      expect(metrics).toContain('le="500"');
      expect(metrics).toContain('le="1000"');
      expect(metrics).toContain('le="5000"');
      expect(metrics).toContain('le="10000"');
    });

    it('LLM request latency has buckets suitable for API call durations', async () => {
      recordLLMRequest('qwen', 'qwen3-max', 3000, 200);
      
      const metrics = await registry.metrics();
      
      // LLM calls can be slow, should have high buckets
      expect(metrics).toContain('le="60000"');
      expect(metrics).toContain('le="120000"');
    });
  });

  describe('registry export', () => {
    it('exports all metrics in Prometheus format', async () => {
      recordTurnCommit(100, true);
      recordToolExec('test_tool', 50, true);
      
      const metrics = await registry.metrics();
      
      // Should have proper Prometheus format
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');
      expect(metrics).toContain('histogram');
      expect(metrics).toContain('counter');
    });

    it('includes default app label', async () => {
      recordTurnCommit(100, true);
      
      const metrics = await registry.metrics();
      
      expect(metrics).toContain('app="nullai-backend"');
    });
  });
});








