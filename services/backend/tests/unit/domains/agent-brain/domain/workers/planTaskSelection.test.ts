import { describe, expect, it } from 'vitest';

import {
  collectDiscoveryPlanTitles,
  parseApprovedPlanItems,
  parseMissionEnvelopeFromPlan,
  selectStartingPlanTask,
} from '@/domains/agent-brain/domain/workers/planTaskSelection';

describe('planTaskSelection', () => {
  it('ignores plan metadata bullets and keeps actionable objective steps', () => {
    const planMarkdown = [
      '# Attack Surface Discovery for psut.edu.jo',
      '## Goal',
      '- Target: psut.edu.jo (domain, verified)',
      '- Execution mode: cloud-managed environment',
      '- Rules: Stay within verified targets only; do not assume reachability to private/internal services unless publicly accessible',
      '- Objectives: Build complete baseline inventory including subdomains, HTTP/HTTPS services, endpoints, and technology fingerprints',
      '- Execute port scanning to identify all open ports and network services',
      '- Run deep web crawl for endpoint enumeration across discovered HTTP surfaces',
      '- Constraint: Cloud-only execution means internal services not publicly reachable cannot be scanned',
      '- New hypothesis: N/A',
    ].join('\n');

    const parsed = parseApprovedPlanItems(planMarkdown);

    expect(parsed.map((item) => item.title)).toEqual([
      'Build complete baseline inventory including subdomains, HTTP/HTTPS services, endpoints, and technology fingerprints',
      'Execute port scanning to identify all open ports and network services',
      'Run deep web crawl for endpoint enumeration across discovered HTTP surfaces',
    ]);

    expect(collectDiscoveryPlanTitles(parsed)).not.toEqual(
      expect.arrayContaining([
        'Target: psut.edu.jo (domain, verified)',
        'Execution mode: cloud-managed environment',
        'Rules: Stay within verified targets only; do not assume reachability to private/internal services unless publicly accessible',
      ]),
    );
  });

  it('selects the first actionable parsed task instead of metadata fallback', () => {
    const planMarkdown = [
      '# Vulnerability Assessment for api.example.com',
      '## Goal',
      '- Target: api.example.com (verified)',
      '- Execution mode: cloud-managed environment',
      '- Rules: Stay within verified scope',
      '- Validate CVE-2025-1234 auth bypass on api.example.com',
      '- Package evidence and remediation notes',
    ].join('\n');

    expect(
      selectStartingPlanTask({
        planMarkdown,
        skillSlugs: ['broad-surface-scan'],
      }),
    ).toMatchObject({
      title: 'Validate CVE-2025-1234 auth bypass on api.example.com',
      executionMode: 'validation',
      source: 'plan_markdown',
    });
  });

  it('attaches graph-lite mission envelopes to parsed plan steps', () => {
    const planMarkdown = [
      '# Attack Surface Discovery for app.example.com',
      '## Tasks',
      '1. Map unauthenticated surface',
      '2. Replan based on discovered attack surface',
      '',
      '## Mission Envelope',
      '```json',
      JSON.stringify({
        missions: [
          {
            id: 'task-1',
            question: 'What unauthenticated surface exists?',
            why_ready_now: 'Inventory prechecks identified app.example.com.',
            required_evidence: ['reachable routes', 'status codes'],
            expected_artifact: 'Surface map',
            stop_condition: 'Primary routes are mapped or blocked.',
            assigned_skills: ['broad-surface-scan'],
          },
          {
            id: 'task-2',
            question: 'Which validation mission should run next?',
            why_ready_now: 'Surface map exists.',
            required_evidence: ['surface map'],
            expected_artifact: 'Replan checkpoint',
            stop_condition: 'Next mission is selected.',
            assigned_skills: [],
          },
        ],
      }),
      '```',
    ].join('\n');

    expect(parseMissionEnvelopeFromPlan(planMarkdown)).toHaveLength(2);
    const parsed = parseApprovedPlanItems(planMarkdown);
    expect(parsed[0]).toMatchObject({
      id: 'task-1',
      title: 'What unauthenticated surface exists?',
      notes: 'Inventory prechecks identified app.example.com.',
      mission: {
        question: 'What unauthenticated surface exists?',
        whyReadyNow: 'Inventory prechecks identified app.example.com.',
        requiredEvidence: ['reachable routes', 'status codes'],
        expectedArtifact: 'Surface map',
        stopCondition: 'Primary routes are mapped or blocked.',
        assignedSkills: ['broad-surface-scan'],
      },
    });
    expect(selectStartingPlanTask({ plan: parsed })).toMatchObject({
      stepId: 'task-1',
      mission: expect.objectContaining({
        question: 'What unauthenticated surface exists?',
      }),
    });
  });

  it('uses mission nodes as the executable plan source when a mission envelope exists', () => {
    const markdownTasks = Array.from(
      { length: 23 },
      (_, index) => `${index + 1}. Markdown-only execution detail ${index + 1}`,
    );
    const planMarkdown = [
      '# Attack Surface Discovery for app.example.com',
      '## Tasks',
      ...markdownTasks,
      '',
      '## Mission Envelope',
      '```json',
      JSON.stringify({
        missions: [
          {
            id: 'task-1',
            question: 'What new broad coverage is actually missing?',
            why_ready_now: 'Prior scan coverage is stale for app.example.com.',
            required_evidence: ['query_inventory', 'scan.coverage notes'],
            expected_artifact: 'Coverage decision for app.example.com',
            stop_condition: 'Need for broad scan is justified or rejected.',
            assigned_skills: ['broad-surface-scan'],
          },
          {
            id: 'task-2',
            question: 'Which follow-up validation is highest value?',
            why_ready_now: 'Coverage gap decision exists.',
            required_evidence: ['coverage decision'],
            expected_artifact: 'Next validation mission',
            stop_condition: 'Next step is selected.',
            assigned_skills: ['sql-injection'],
          },
          {
            id: 'task-3',
            question: 'What blocker or evidence should be persisted?',
            why_ready_now: 'Targeted step selection exists.',
            required_evidence: ['selected target'],
            expected_artifact: 'Bounded blocker or evidence note',
            stop_condition: 'Note objective is complete.',
            assigned_skills: [],
          },
          {
            id: 'task-4',
            question: 'Should the run replan or conclude?',
            why_ready_now: 'Execution outcome exists.',
            required_evidence: ['execution outcome'],
            expected_artifact: 'Replan or closeout decision',
            stop_condition: 'Next run direction is explicit.',
            assigned_skills: [],
          },
        ],
      }),
      '```',
    ].join('\n');

    const parsed = parseApprovedPlanItems(planMarkdown);

    expect(parsed).toHaveLength(4);
    expect(parsed.map((item) => item.id)).toEqual(['task-1', 'task-2', 'task-3', 'task-4']);
    expect(parsed.map((item) => item.id)).not.toEqual(expect.arrayContaining(['task-5', 'task-23']));
    expect(parsed.map((item) => item.title)).toEqual([
      'What new broad coverage is actually missing?',
      'Which follow-up validation is highest value?',
      'What blocker or evidence should be persisted?',
      'Should the run replan or conclude?',
    ]);
  });

  it('uses separately stored mission nodes as the executable plan source', () => {
    const missionEnvelopeNodes = [
      {
        id: 'task-1',
        question: 'What unauthenticated surface exists?',
        whyReadyNow: 'Inventory prechecks identified app.example.com.',
        requiredEvidence: ['reachable routes', 'status codes'],
        expectedArtifact: 'Surface map',
        stopCondition: 'Primary routes are mapped or blocked.',
        assignedSkills: ['broad-surface-scan'],
      },
    ];

    const parsed = parseApprovedPlanItems(
      [
        '# Attack Surface Discovery for app.example.com',
        '## Tasks',
        '1. User-facing overview without internal metadata',
      ].join('\n'),
      missionEnvelopeNodes,
    );

    expect(parsed).toEqual([
      {
        id: 'task-1',
        title: 'What unauthenticated surface exists?',
        status: 'pending',
        notes: 'Inventory prechecks identified app.example.com.',
        mission: {
          question: 'What unauthenticated surface exists?',
          whyReadyNow: 'Inventory prechecks identified app.example.com.',
          requiredEvidence: ['reachable routes', 'status codes'],
          expectedArtifact: 'Surface map',
          stopCondition: 'Primary routes are mapped or blocked.',
          assignedSkills: ['broad-surface-scan'],
        },
      },
    ]);
  });
});
