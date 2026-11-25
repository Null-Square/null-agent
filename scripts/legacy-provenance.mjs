#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const tag = 'legacy/v3.2-final';
const baseline = '981a70c4a3d81dd3885120ef0f1b11306035de49';
const lastLegacyUi = '2c8340798e8f776f438e377410ec3998887dacdf';
const destination = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const usage = [
  'node scripts/legacy-provenance.mjs --source <local-legacy-checkout> [--ref HEAD | --index | --worktree] [--map <private.json>]',
  '',
  'Reads the pinned backend and frontend checkpoints and compares a commit, staged index, or working tree.',
  'Compares files under packages/ and services/. Run against the final candidate commit for release evidence.',
  'A private optional JSON object maps a destination path to its reviewed, renamed source path.',
  'Use --map - to read the mapping from standard input.',
  'For mapped .ts to .mjs pairs, npm ci and Node 22.18+ enable declaration comparison after type removal.',
  'Keep the output local. It contains private source paths and blob identities.',
].join('\n');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function files(records, fromIndex = false) {
  const entries = new Map();
  for (const record of records.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, second, third] = record.slice(0, tab).split(' ');
    if (fromIndex && third !== '0') throw new Error('Resolve index conflicts before comparing files.');
    if (mode === '160000') throw new Error('A submodule needs its own provenance comparison.');
    const path = record.slice(tab + 1);
    entries.set(path, fromIndex ? second : third);
  }
  return entries;
}

function commit(repo, ref) {
  return git(repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').trim();
}

function workingFiles(scoped) {
  const root = realpathSync(destination);
  const names = new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', ...scoped).split('\0').filter(Boolean));
  const entries = new Map();
  const batch = [];
  function hashBatch() {
    if (!batch.length) return;
    // Git applies the same clean/EOL rules it uses to stage a regular file.
    // Omitting -w keeps the destination object database untouched.
    const hashes = git(root, 'hash-object', '--', ...batch).trim().split(/\r?\n/);
    batch.forEach((name, i) => entries.set(name, hashes[i]));
    batch.length = 0;
  }
  for (const name of names) {
    const absolute = path.join(root, name);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || path.relative(absolute, realpathSync(absolute)) !== '') throw new Error('Review a linked file separately: ' + JSON.stringify(name));
    batch.push(name);
    if (batch.length === 16) hashBatch();
  }
  hashBatch();
  return entries;
}

// Match complete declarations after removing types. Never import or run either
// module. An explicit export list is allowed only for verified declarations.
function matchedDeclarations(source, candidate) {
  const ts = require('typescript');
  function declarations(code) {
    const tree = ts.createSourceFile('module.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (tree.parseDiagnostics.length) throw new Error('Could not parse a mapped JavaScript module.');
    return tree.statements;
  }
  const emitted = stripTypeScriptTypes(source, { mode: 'transform' });
  const comparable = statement => statement.getText().replace(/^export\s+/, '');
  const sourceStatements = new Set(declarations(emitted).map(comparable));
  const definitions = new Set();
  const exports = new Set();
  for (const statement of declarations(candidate)) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) exports.add((item.propertyName ?? item.name).text);
    } else if (ts.isVariableStatement(statement) && sourceStatements.has(comparable(statement))) {
      for (const declaration of statement.declarationList.declarations) definitions.add(declaration.name.getText());
    } else {
      return 0;
    }
  }
  return [...exports].every(name => definitions.has(name)) ? definitions.size : 0;
}

function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string' }, ref: { type: 'string' }, index: { type: 'boolean' }, worktree: { type: 'boolean' },
    map: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return console.log(usage);
  if (!values.source || [values.ref, values.index, values.worktree].filter(Boolean).length > 1) throw new Error(usage);
  if (commit(values.source, 'refs/tags/' + tag) !== baseline) throw new Error('Legacy tag differs from the pinned commit.');
  if (git(destination, 'rev-parse', '--show-object-format').trim() !== 'sha1') throw new Error('Candidate must use the same Git object format as the baseline.');

  const scoped = ['--', 'packages/', 'services/'];
  const original = new Map([
    ...files(git(values.source, 'ls-tree', '-rz', baseline, '--', 'services/backend/', 'packages/contracts/')),
    ...files(git(values.source, 'ls-tree', '-rz', lastLegacyUi, '--', 'services/frontend/', 'packages/design-tokens/')),
  ]);
  const candidateId = commit(destination, values.ref ?? 'HEAD');
  let candidate;
  let basis = 'commit ';
  if (values.index) {
    candidate = files(git(destination, 'ls-files', '-sz', ...scoped), true);
    basis = 'staged index, based on ';
  } else if (values.worktree) {
    candidate = workingFiles(scoped);
    basis = 'mutable working tree, based on ';
  } else {
    candidate = files(git(destination, 'ls-tree', '-rz', candidateId, ...scoped));
  }
  if (!candidate.size) throw new Error('No candidate files under packages/ or services/. Stage the reviewed files and use --index, or select their commit with --ref.');

  const mapping = values.map ? JSON.parse(readFileSync(values.map === '-' ? 0 : values.map, 'utf8').replace(/^\uFEFF/, '')) : {};
  if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object') throw new Error('--map must be a JSON object.');
  for (const [path, origin] of Object.entries(mapping)) {
    if (!candidate.has(path) || typeof origin !== 'string' || !original.has(origin)) throw new Error('Unresolved private map entry for ' + JSON.stringify(path));
  }

  const byBlob = new Map();
  for (const [path, hash] of original) {
    if (!byBlob.has(hash)) byBlob.set(hash, []);
    byBlob.get(hash).push(path);
  }
  console.log('Backend and contracts           ' + tag + ' ' + baseline);
  console.log('Frontend and shared UI          ' + lastLegacyUi);
  console.log('Local candidate ' + basis + candidateId);
  console.log('Scope           packages/ and services/. Comparisons use Git blob bytes.');
  console.log('Different bytes at the same path establish a difference. Derivation needs review.');
  console.log('Status\tDestination\tCandidate blob\tSource path\tLegacy blob');
  const counts = new Map();
  for (const [path, hash] of candidate) {
    const matching = byBlob.get(hash) ?? [];
    const mapped = Object.hasOwn(mapping, path);
    let source;
    let status;
    if (mapped) {
      source = mapping[path];
      status = original.get(source) === hash ? 'exact (mapped)' : 'different (mapped)';
      if (original.get(source) !== hash && source.endsWith('.ts') && path.endsWith('.mjs')) {
        const contents = values.worktree ? readFileSync(new URL('../' + path.split('/').map(encodeURIComponent).join('/'), import.meta.url), 'utf8') : git(destination, 'cat-file', 'blob', hash);
        const matched = matchedDeclarations(git(values.source, 'cat-file', 'blob', original.get(source)), contents);
        if (matched) status = 'matching type-stripped declarations (' + matched + ')';
      }
    } else if (original.get(path) === hash) {
      source = path;
      status = 'exact (same path)';
    } else if (matching.length === 1) {
      source = matching[0];
      status = 'exact (other path)';
    } else if (matching.length > 1) {
      status = 'exact (multiple paths)';
    } else if (original.has(path)) {
      source = path;
      status = 'different (same path)';
    } else {
      status = 'no identified source';
    }
    counts.set(status, (counts.get(status) ?? 0) + 1);
    console.log([status, JSON.stringify(path), hash, source ? JSON.stringify(source) : '-', source ? original.get(source) : matching.length ? hash : '-'].join('\t'));
  }
  console.log('\nCompared ' + candidate.size + ' candidate files.');
  for (const [status, count] of counts) console.log(String(count).padStart(5) + '  ' + status);
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not compare Git objects.');
  process.exitCode = 1;
}
