import fs from 'fs';
import path from 'path';
import {
  buildGeneratedAgentCatalogPolicies,
  renderGeneratedAgentCatalogPolicy,
} from '../src/app/services/agent/agentCatalogPolicySnapshots';

const OUTPUT_DIR = path.resolve(__dirname, '..', 'config', 'policies');

const readIfExists = (filePath: string): string | null =>
  fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;

const main = (): void => {
  const checkOnly = process.argv.includes('--check');
  const generatedPolicies = buildGeneratedAgentCatalogPolicies();
  const mismatches: string[] = [];

  if (!fs.existsSync(OUTPUT_DIR)) {
    if (checkOnly) {
      throw new Error(`Policy directory does not exist: ${OUTPUT_DIR}`);
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  for (const generated of generatedPolicies) {
    const filePath = path.join(OUTPUT_DIR, generated.fileName);
    const rendered = renderGeneratedAgentCatalogPolicy(generated);

    if (checkOnly) {
      const existing = readIfExists(filePath);
      if (existing !== rendered) {
        mismatches.push(path.relative(process.cwd(), filePath).replace(/\\/g, '/'));
      }
      continue;
    }

    fs.writeFileSync(filePath, rendered, 'utf8');
  }

  if (checkOnly && mismatches.length > 0) {
    console.error('Agent catalog policy files are out of sync with PhaseProfileRegistry:');
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    console.error('Run `npm run catalog:policies` from services/backend.');
    process.exit(1);
  }

  if (checkOnly) {
    console.log('Agent catalog policy files are in sync.');
  } else {
    console.log(`Wrote ${generatedPolicies.length} agent catalog policy files to ${OUTPUT_DIR}`);
  }
};

main();
