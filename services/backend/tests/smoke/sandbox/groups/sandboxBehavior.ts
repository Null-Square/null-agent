import type { PhaseSmokeGroup } from '../types';

export const sandboxBehaviorGroup: PhaseSmokeGroup = {
  phase: 'sandbox-behavior',
  tools: [],
  extraChecks: [
    {
      name: 'workspace is writable and stable across execs',
      command: [
        'test -d /workspace',
        'mkdir -p /workspace/.artifacts/smoke/behavior',
        'printf NULLAI_SANDBOX_WORKSPACE_BEHAVIOR_OK > /workspace/.artifacts/smoke/behavior/persist.txt',
        'cat /workspace/.artifacts/smoke/behavior/persist.txt',
      ].join(' && '),
      expect: 'NULLAI_SANDBOX_WORKSPACE_BEHAVIOR_OK',
    },
    {
      name: 'shell supports pipelines and heredocs used by agents',
      command: [
        'cat > /workspace/.artifacts/smoke/behavior/input.txt <<\'EOF\'',
        'alpha',
        'beta',
        'gamma',
        'EOF',
        'grep beta /workspace/.artifacts/smoke/behavior/input.txt | tr a-z A-Z',
        'echo NULLAI_SHELL_SCRIPTING_OK',
      ].join('\n'),
      expect: 'NULLAI_SHELL_SCRIPTING_OK',
    },
    {
      name: 'python jq node can exchange JSON artifacts',
      command: [
        'python3 - <<\'PY\'',
        'import json',
        'json.dump({"ok": True, "items": [1, 2, 3]}, open("/workspace/.artifacts/smoke/behavior/data.json", "w"))',
        'PY',
        'jq -e \'.ok == true and (.items | length) == 3\' /workspace/.artifacts/smoke/behavior/data.json >/dev/null',
        'node -e "const data=require(\'/workspace/.artifacts/smoke/behavior/data.json\'); if(!data.ok || data.items.length !== 3) process.exit(1)"',
        'echo NULLAI_JSON_INTEROP_OK',
      ].join('\n'),
      expect: 'NULLAI_JSON_INTEROP_OK',
    },
    {
      name: 'headless chromium can render deterministic HTML',
      command: [
        "timeout 20s chromium --headless --disable-gpu --disable-dev-shm-usage --no-sandbox --dump-dom 'data:text/html,<p>NULLAI_CHROMIUM_DATA_OK</p>' > /workspace/.artifacts/smoke/behavior/chromium-data.html",
        'grep -q "NULLAI_CHROMIUM_DATA_OK" /workspace/.artifacts/smoke/behavior/chromium-data.html',
        'echo NULLAI_CHROMIUM_RENDER_OK',
      ].join(' && '),
      expect: 'NULLAI_CHROMIUM_RENDER_OK',
    },
  ],
};
