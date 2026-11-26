import { writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import type { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import { logger } from '@/shared/logger';

const CREDENTIALS_FILE = '.credentials';

const renderHostsLine = (appliesToHosts: string[]): string =>
  appliesToHosts.length === 0 ? '(any)' : appliesToHosts.join(', ');

async function decryptAll(
  service: ScopeAccessMaterialService,
  orgId: string,
  scopeId: string,
  materialIds: string[],
): Promise<Map<string, string>> {
  // Resolve secrets for all materials via the service (handles decryption).
  // Each resolve call is independent so we run them concurrently.
  const results = await Promise.allSettled(
    materialIds.map((id) => service.resolveSecretById(orgId, scopeId, id)),
  );

  const secrets = new Map<string, string>();
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      secrets.set(materialIds[i], result.value);
    } else {
      logger.warn({ materialId: materialIds[i], err: result.reason }, 'Failed to decrypt access material for credentials file');
    }
  }
  return secrets;
}

export async function writeScopeCredentialsFile(params: {
  workspaceDir: string;
  orgId: string;
  scopeId: string;
  service: ScopeAccessMaterialService;
}): Promise<void> {
  const { workspaceDir, orgId, scopeId, service } = params;

  const materials = await service.listScopeContextMaterials(scopeId);
  if (materials.length === 0) {
    return;
  }

  const materialIds = materials.map((m) => m.id);
  const secrets = await decryptAll(service, orgId, scopeId, materialIds);

  const lines: string[] = [
    '# Scope Credentials',
    '# Read this file before attempting manual login or credential guessing.',
    '# Do not include raw values from this file in findings, reports, or notes.',
    '',
  ];

  for (const material of materials) {
    const secret = secrets.get(material.id);
    if (secret === undefined) {
      continue; // Decrypt failed — skip silently, already logged
    }

    const hosts = renderHostsLine(material.appliesToHosts);

    switch (material.kind) {
      case 'login_credential':
        lines.push(`[login_credential] ${material.label}`);
        lines.push(`  username: ${material.username ?? ''}`);
        lines.push(`  password: ${secret}`);
        lines.push(`  hosts: ${hosts}`);
        if (material.notes) lines.push(`  notes: ${material.notes}`);
        lines.push('');
        break;

      case 'custom_header':
        lines.push(`[custom_header] ${material.label}`);
        lines.push(`  header_name: ${material.headerName ?? ''}`);
        lines.push(`  header_value: ${secret}`);
        lines.push(`  hosts: ${hosts}`);
        if (material.notes) lines.push(`  notes: ${material.notes}`);
        lines.push('');
        break;

      case 'bearer_token':
        lines.push(`[bearer_token] ${material.label}`);
        lines.push(`  token: ${secret}`);
        lines.push(`  hosts: ${hosts}`);
        if (material.notes) lines.push(`  notes: ${material.notes}`);
        lines.push('');
        break;

      case 'cookie_session':
        lines.push(`[cookie_session] ${material.label}`);
        lines.push(`  cookie_header: ${secret}`);
        lines.push(`  hosts: ${hosts}`);
        if (material.notes) lines.push(`  notes: ${material.notes}`);
        lines.push('');
        break;
    }
  }

  const filePath = join(workspaceDir, CREDENTIALS_FILE);
  try {
    await writeFile(filePath, lines.join('\n'), { encoding: 'utf8' });
    await chmod(filePath, 0o600);
  } catch (error) {
    logger.warn({ err: error, filePath }, 'Failed to write scope credentials file');
  }
}
