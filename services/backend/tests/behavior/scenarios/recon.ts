import {
  IngestScanArtifact,
  ReportNote,
  ReportService,
} from '../../../src/domains/agent-brain/adapters/tools/builtins/securityops';
import { asRecord, asString, firstTool } from '../assertions';
import type { BehaviorScenario, ObservedToolCall } from '../types';

/**
 * Does recon actually capture *versions*?
 *
 * Threat Watch can only match what recon recorded, and a product name without a
 * version stays in inventory without producing an exposure match. So the
 * question that decides whether the whole feature has
 * anything to work with is not "did the agent find WordPress", it is "did it write down
 * 6.4.2".
 *
 * These are model-in-the-loop canaries rather than unit tests on purpose. The
 * behaviour under test is a *prompt and tool-description* behaviour: nothing in
 * the code forces the agent to carry a version across from scanner output into
 * a note. When one of these fails, the fix is a prompt, a skill, or a tool
 * description — not a branch. That diagnosis is the point of running them.
 */

const noteCalls = (calls: ObservedToolCall[], ntype: string): ObservedToolCall[] =>
  calls.filter(
    (call) => call.name === 'report_note' && asString(asRecord(call.args).ntype) === ntype,
  );

const techFingerprints = (calls: ObservedToolCall[]) => noteCalls(calls, 'tech.fingerprint');

const dataOf = (call: ObservedToolCall) => asRecord(asRecord(call.args).data);

/**
 * Every component the agent recorded, from either canonical writer.
 *
 * `report_note(tech.fingerprint)` and `report_service` both project into
 * `inventory_components`, so both satisfy what Threat Watch needs. Asserting on
 * one of them would test the mechanism rather than the outcome — and a live run
 * showed the model legitimately reaching for the other while still carrying the
 * version, which is the thing that actually matters.
 */
const recordedComponents = (
  calls: ObservedToolCall[],
): Array<{ product: string; version: string }> => [
  ...techFingerprints(calls).map((call) => ({
    product: asString(dataOf(call).product).toLowerCase(),
    version: asString(dataOf(call).version),
  })),
  ...calls
    .filter((call) => call.name === 'report_service')
    .map((call) => ({
      product: asString(asRecord(call.args).product).toLowerCase(),
      version: asString(asRecord(call.args).version),
    })),
];

const recordedProducts = (calls: ObservedToolCall[]): string[] =>
  recordedComponents(calls).map((entry) => entry.product);

const recordedVersionFor = (calls: ObservedToolCall[], product: string): string | undefined =>
  recordedComponents(calls)
    .filter((entry) => entry.product.includes(product))
    .map((entry) => entry.version)
    .find((version) => version.length > 0);

export const reconScenarios: BehaviorScenario[] = [
  {
    id: 'recon-records-version-from-httpx-output',
    title: 'Recon carries the version across from httpx output into the fingerprint note',
    why: 'A fingerprint without a version can never raise an alert, so losing it here silently caps Threat Watch coverage.',
    tools: [ReportNote, ReportService, IngestScanArtifact],
    prompt: [
      'You are the recon executor for an authorized assessment of shop.example.com.',
      'httpx has already run. Its JSON line for the target was:',
      JSON.stringify({
        url: 'https://shop.example.com',
        port: 443,
        webserver: 'nginx/1.18.0',
        tech: ['WordPress:6.4.2', 'PHP:8.1.2', 'Cloudflare'],
        status_code: 200,
      }),
      'The artifact has already been ingested, so do not ingest it again.',
      'Record the WordPress finding in canonical inventory. Take exactly one harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors: string[] = [];
      const call = firstTool(calls);
      if (!call) return ['expected a canonical inventory write, observed no tool call'];

      const products = recordedProducts(calls);
      if (!products.some((product) => product.includes('wordpress'))) {
        errors.push(`expected a wordpress tech.fingerprint, observed products: ${products.join(', ') || 'none'}`);
      }

      const version = recordedVersionFor(calls, 'wordpress');
      if (version !== '6.4.2') {
        errors.push(
          `expected the note to carry version 6.4.2, observed ${version ? `"${version}"` : 'no version field'}`,
        );
      }

      return errors;
    },
  },
  {
    id: 'recon-does-not-invent-a-version',
    title: 'Recon omits the version when the scanner did not report one',
    why: 'An invented version produces a confident match against software nobody is running, which is the failure mode the whole trust budget exists to prevent.',
    tools: [ReportNote, ReportService],
    prompt: [
      'You are the recon executor for an authorized assessment of shop.example.com.',
      'httpx reported the technology "Elementor" on this host with no version information of any kind.',
      'No other source has told you anything about its version.',
      'Record it in canonical inventory. Take exactly one harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors: string[] = [];
      const components = recordedComponents(calls);
      if (components.length === 0) {
        return ['expected elementor recorded in canonical inventory, observed none'];
      }

      for (const component of components) {
        if (component.version.length > 0) {
          errors.push(
            `expected no version when none was observed, but the record claims "${component.version}"`,
          );
        }
      }

      return errors;
    },
  },
  {
    id: 'recon-records-wordpress-plugin-versions',
    title: 'Recon records WordPress plugins as their own components, with versions',
    why: 'Plugins, not core, are what actually compromises WordPress sites; if recon folds them into one WordPress note a plugin advisory feed has nothing to match.',
    tools: [ReportNote, ReportService],
    prompt: [
      'You are the recon executor for an authorized assessment of shop.example.com.',
      'The homepage markup references these WordPress assets:',
      [
        '/wp-content/plugins/elementor/assets/css/frontend.min.css?ver=3.21.4',
        '/wp-content/plugins/woocommerce/assets/js/frontend.js?ver=8.6.1',
      ].join('\n'),
      'The generator meta tag says WordPress 6.4.2.',
      'Record the Elementor plugin in canonical inventory as its own component. Take exactly one harness action.',
    ].join('\n\n'),
    expect: (calls) => {
      const errors: string[] = [];
      const products = recordedProducts(calls);

      if (!products.some((product) => product.includes('elementor'))) {
        errors.push(
          `expected elementor recorded as its own tech.fingerprint, observed products: ${products.join(', ') || 'none'}`,
        );
      }

      const version = recordedVersionFor(calls, 'elementor');
      if (version !== '3.21.4') {
        errors.push(
          `expected elementor version 3.21.4, observed ${version ? `"${version}"` : 'no version field'}`,
        );
      }

      // The core version is the trap: WordPress substitutes it for plugins that
      // enqueue without their own, so a plugin note carrying 6.4.2 usually means
      // the agent copied the wrong number.
      if (version === '6.4.2') {
        errors.push('elementor was recorded with the WordPress core version, which is not its version');
      }

      return errors;
    },
  },
];
