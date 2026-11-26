import { Pencil, X } from 'lucide-react';
import { IconButton, ListEmptyState, RecordTable, SecretValue } from '@null-ai/design-tokens/ui';
import { useDeleteScopeAccessMaterialMutation } from '@/modules/security-ops/api';
import type { ScopeAccessMaterial } from '@/modules/security-ops/types';

interface AccessMaterialListProps {
  scopeId: string;
  materials: ScopeAccessMaterial[];
  onEdit: (material: ScopeAccessMaterial) => void;
  canManage?: boolean;
}

/**
 * Credentials and headers as the one data table.
 *
 * They used to render as a row of read-only boxes styled like input fields,
 * which invited a click that did nothing and put form chrome where data
 * belongs. Secrets are write-only — the API never returns them — so the mask
 * carries no reveal affordance.
 */
export function AccessMaterialList({
  scopeId,
  materials,
  onEdit,
  canManage = true,
}: AccessMaterialListProps) {
  const deleteMutation = useDeleteScopeAccessMaterialMutation();

  const handleDelete = (material: ScopeAccessMaterial) => {
    if (!window.confirm(`Delete "${material.label}"?`)) return;
    deleteMutation.mutate({ scopeId, materialId: material.id });
  };

  if (materials.length === 0) {
    return (
      <ListEmptyState
        className="border-0"
        icon="credentials"
        title="Nothing stored yet"
        description="Agents will test unauthenticated surface only until something is added here."
      />
    );
  }

  const isCredential = (material: ScopeAccessMaterial) => material.kind === 'login_credential';

  return (
    <RecordTable
      rows={materials}
      getRowKey={(material) => material.id}
      titleHeader="Identity"
      title={(material) => (isCredential(material) ? material.username || material.label : material.headerName || material.label)}
      subtitle={(material) => material.notes || (isCredential(material) ? 'Login credential' : 'Custom header')}
      rowActionLabel={(material) => `Edit ${material.label}`}
      onRowClick={(material) => onEdit(material)}
      columns={[
        {
          key: 'secret',
          header: isCredential(materials[0]) ? 'Password' : 'Value',
          width: '160px',
          render: (material) => (
            <SecretValue label={`${isCredential(material) ? 'password' : 'value'} for ${material.label}`} />
          ),
        },
      ]}
      actions={
        canManage
          ? (material) => (
              <>
                <IconButton aria-label={`Edit ${material.label}`} onClick={() => onEdit(material)}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton aria-label={`Delete ${material.label}`} onClick={() => handleDelete(material)}>
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </>
            )
          : undefined
      }
    />
  );
}
