import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalWorkspaceManager } from '@/domains/agent-brain/adapters/workspace/LocalWorkspaceManager';
import type { WorkspaceManager } from '@/domains/agent-brain/ports';

export const createTestWorkspaceManager = (): WorkspaceManager => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-agent-tests-'));
  return new LocalWorkspaceManager({ root });
};
