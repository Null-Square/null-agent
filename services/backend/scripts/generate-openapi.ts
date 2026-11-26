#!/usr/bin/env ts-node
/**
 * Generate OpenAPI Spec
 * 
 * Generates OpenAPI 3.0 specification from Zod schemas.
 * Outputs to docs/openapi.json and optionally openapi.yaml.
 * 
 * Usage: npm run generate:openapi
 */

import * as fs from 'fs';
import * as path from 'path';

// Import the registry (triggers all path registrations)
import { generateOpenAPIDocument } from '../src/shared/openapi';

const OUTPUT_DIR = path.join(__dirname, '..', 'docs');
const JSON_OUTPUT = path.join(OUTPUT_DIR, 'openapi.json');

async function main() {
  console.log('🔧 Generating OpenAPI specification...');
  
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // Generate the spec
  const spec = generateOpenAPIDocument();
  
  // Count endpoints
  const pathCount = Object.keys(spec.paths || {}).length;
  const operationCount = Object.values(spec.paths || {}).reduce((count, path) => {
    return count + Object.keys(path as object).filter(k => 
      ['get', 'post', 'put', 'patch', 'delete'].includes(k)
    ).length;
  }, 0);
  
  // Write JSON
  fs.writeFileSync(JSON_OUTPUT, JSON.stringify(spec, null, 2));
  console.log(`✅ Written: ${JSON_OUTPUT}`);
  
  console.log(`\n📊 OpenAPI Spec Summary:`);
  console.log(`   - Paths: ${pathCount}`);
  console.log(`   - Operations: ${operationCount}`);
  console.log(`   - Tags: ${(spec.tags || []).length}`);
  console.log(`\n🎉 Done!`);
}

main().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
