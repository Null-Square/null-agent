const fs = require('node:fs');
const path = require('node:path');

const readState = (statePath) => {
  const resolved = path.resolve(String(statePath));
  if (!fs.existsSync(resolved)) {
    return { value: 'initial', dispatches: { read: 0, update: 0, denied: 0 } };
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
};

const writeState = (statePath, state) => {
  const resolved = path.resolve(String(statePath));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
};

const stateSchema = {
  type: 'object',
  properties: {
    statePath: { type: 'string' },
    value: { type: 'string' },
  },
  required: ['statePath'],
  additionalProperties: false,
};

const defineTool = (id, risk, run) => ({
  manifest: {
    id,
    summary: `${id} deterministic E8 Behavior Lab fixture.`,
    argsSchema: stateSchema,
    meta: { category: 'behavior_lab', risk, returns: 'json' },
  },
  meta: {
    name: id,
    description: `${id} deterministic E8 Behavior Lab fixture.`,
    category: 'behavior_lab',
    schema: stateSchema,
    risks: [risk],
  },
  run,
});

const readTool = defineTool('behavior_pipeline_read', 'read', async (args) => {
  const state = readState(args.statePath);
  state.dispatches.read += 1;
  writeState(args.statePath, state);
  return { ok: true, data: { value: state.value, source: 'temporary-state' } };
});

const updateTool = defineTool('behavior_pipeline_update', 'write', async (args) => {
  const state = readState(args.statePath);
  state.dispatches.update += 1;
  state.value = String(args.value ?? state.value);
  writeState(args.statePath, state);
  return { ok: true, data: { value: state.value, updated: true } };
});

const deniedTool = defineTool('behavior_pipeline_denied', 'write', async (args) => {
  const state = readState(args.statePath);
  state.dispatches.denied += 1;
  writeState(args.statePath, state);
  return { ok: true, data: { forbiddenEffectReached: true } };
});

module.exports = {
  tools: [readTool, updateTool, deniedTool],
  legacyRead: readTool.run,
};
