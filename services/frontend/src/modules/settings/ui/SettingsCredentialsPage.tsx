import { useMemo, useState } from 'react';
import { Button, ListEmptyState, ListSkeleton, SectionPanel } from '@null-ai/design-tokens/ui';

import SettingsLayout from './SettingsLayout';
import { useAuth } from '@/modules/auth';
import {
  useOrganizationMembersQuery,
  useScopeAccessMaterialsQuery,
} from '@/modules/security-ops/api';
import type { AccessMaterialKind, ScopeAccessMaterial } from '@/modules/security-ops/types';
import { AccessMaterialEditorModal } from '@/modules/scopes/ui/components/AccessMaterialEditorModal';
import { AccessMaterialList } from '@/modules/scopes/ui/components/AccessMaterialList';
import { useScope } from '@shared/contexts/ScopeContext';

type EditorState = {
  kind: AccessMaterialKind;
  material?: ScopeAccessMaterial;
} | null;

export default function SettingsCredentialsPage() {
  const { user } = useAuth();
  const { activeScopeId, scopes, isLoading: scopesLoading } = useScope();
  const { data: members } = useOrganizationMembersQuery({
    enabled: true,
  });
  const [editorState, setEditorState] = useState<EditorState>(null);

  const currentMember = members?.find((member) => member.userId === user?.id);
  const canManage = ['admin', 'lead'].includes(currentMember?.role ?? 'viewer');

  const activeScope = useMemo(
    () => scopes?.find((s) => s.id === activeScopeId) ?? null,
    [scopes, activeScopeId],
  );

  const { data: materials, isLoading: materialsLoading } = useScopeAccessMaterialsQuery(activeScopeId ?? '');

  const visibleMaterials = materials ?? [];
  const credentialMaterials = visibleMaterials.filter((m) => m.kind === 'login_credential');
  const headerMaterials = visibleMaterials.filter((m) => m.kind !== 'login_credential');

  return (
    <SettingsLayout
      title="Credentials"
      description="Manage encrypted credentials and custom headers for the active scope."
    >
      {!activeScope && !scopesLoading ? (
        <ListEmptyState
          icon="scope"
        title="No scope selected"
          description="Select a scope from the sidebar to manage its credentials and headers."
        />
      ) : (
        <div className="space-y-6">
          <CredentialSection
            title="Authentication credentials"
            description="Add login credentials so agents can test authenticated areas."
            actionLabel="Add credential"
            materials={credentialMaterials}
            scopeId={activeScopeId ?? ''}
            isLoading={materialsLoading}
            canManage={canManage}
            onAdd={() => setEditorState({ kind: 'login_credential' })}
            onEdit={(m) => setEditorState({ kind: m.kind, material: m })}
          />

          <CredentialSection
            title="Custom headers"
            description="JWTs, API keys, WAF bypass tokens, or session cookies to include with requests."
            actionLabel="Add header"
            materials={headerMaterials}
            scopeId={activeScopeId ?? ''}
            isLoading={materialsLoading}
            canManage={canManage}
            onAdd={() => setEditorState({ kind: 'custom_header' })}
            onEdit={(m) => setEditorState({ kind: m.kind, material: m })}
          />
        </div>
      )}

      {activeScopeId && editorState ? (
        <AccessMaterialEditorModal
          isOpen={true}
          onClose={() => setEditorState(null)}
          scopeId={activeScopeId}
          material={editorState.material}
          kind={editorState.kind}
        />
      ) : null}
    </SettingsLayout>
  );
}

function CredentialSection({
  title,
  description,
  actionLabel,
  materials,
  scopeId,
  isLoading,
  canManage,
  onAdd,
  onEdit,
}: {
  title: string;
  description: string;
  actionLabel: string;
  materials: ScopeAccessMaterial[];
  scopeId: string;
  isLoading: boolean;
  canManage: boolean;
  onAdd: () => void;
  onEdit: (material: ScopeAccessMaterial) => void;
}) {
  // The shared panel frame — one hairline, radius 0, no glass. The section
  // icon is gone: colour and copy already say what this is, and a glyph
  // restating them is the redundancy the kit cut elsewhere.
  return (
    <SectionPanel
      title={title}
      description={description}
      flush
      actions={canManage ? <Button variant="outline" size="sm" onClick={onAdd}>{actionLabel}</Button> : undefined}
    >
      {isLoading ? (
        <ListSkeleton label="Reading your credentials" rows={2} />
      ) : (
        <AccessMaterialList
          scopeId={scopeId}
          materials={materials}
          onEdit={onEdit}
          canManage={canManage}
        />
      )}
    </SectionPanel>
  );
}
