const fs = require('node:fs');
const path = require('node:path');

const TOOL_NAME = 'behavior_neutral_effect';

const schema = {
  type: 'object',
  properties: {
    counterPath: { type: 'string' },
    faultPoint: { type: 'string' },
    faultToken: { type: 'string' },
    toolCallId: { type: 'string' },
  },
  required: ['counterPath', 'faultPoint', 'faultToken', 'toolCallId'],
  additionalProperties: false,
};

const manifest = {
  id: TOOL_NAME,
  summary: 'Increment a neutral file-backed counter for assembled-runtime verification.',
  argsSchema: schema,
  meta: {
    category: 'behavior_lab',
    risk: 'write',
    returns: 'json',
  },
};

const meta = {
  name: TOOL_NAME,
  description: manifest.summary,
  category: 'behavior_lab',
  schema,
  risks: ['write'],
};

const readCounter = (counterPath) => {
  if (!fs.existsSync(counterPath)) return { count: 0, effects: [] };
  return JSON.parse(fs.readFileSync(counterPath, 'utf8'));
};

const run = async (args) => {
  const counterPath = path.resolve(String(args.counterPath));
  fs.mkdirSync(path.dirname(counterPath), { recursive: true });
  const state = readCounter(counterPath);
  state.count += 1;
  state.effects.push({
    toolCallId: String(args.toolCallId),
    recordedAt: new Date().toISOString(),
  });
  fs.writeFileSync(counterPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  if (args.faultPoint === 'after_neutral_external_effect_before_tool_terminal') {
    const controllers = globalThis.__nullAiBehaviorFaultControllers;
    const controller = controllers && controllers.get(String(args.faultToken));
    if (controller) controller.abort();
    const error = new Error(`behavior_lab_named_fault:${args.faultPoint}`);
    error.name = 'AbortError';
    throw error;
  }

  return {
    ok: true,
    data: {
      count: state.count,
      neutral: true,
    },
  };
};

module.exports = { manifest, meta, run };
