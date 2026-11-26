import { useEffect, useState } from 'react';
import { Button, Input, Label, Modal, ModalFooter, Textarea } from '@null-ai/design-tokens/ui';
import { Lock } from 'lucide-react';

import { useCreateScopeAccessMaterialMutation, useUpdateScopeAccessMaterialMutation } from '@/modules/security-ops/api';
import type { AccessMaterialKind, ScopeAccessMaterial } from '@/modules/security-ops/types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scopeId: string;
  material?: ScopeAccessMaterial;
  kind: AccessMaterialKind;
}

export function AccessMaterialEditorModal({
  isOpen,
  onClose,
  scopeId,
  material,
  kind,
}: Props) {
  const isEditing = Boolean(material);
  const createMutation = useCreateScopeAccessMaterialMutation();
  const updateMutation = useUpdateScopeAccessMaterialMutation();

  // The kit input is already theme-aware through tokens — this file kept two
  // hand-written palettes for it, one of them with a white pill and a shadow.
  const inputClass = 'h-11';
  
  const labelClass = 'mb-2 block text-sm font-medium text-foreground';

  // Credential fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Header fields
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');

  // Shared
  const [notes, setNotes] = useState('');
  const [hosts, setHosts] = useState('');

  const parseHosts = (value: string): string[] =>
    value
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  useEffect(() => {
    if (material) {
      setUsername(material.username ?? '');
      setHeaderName(material.headerName ?? '');
      setNotes(material.notes ?? '');
      setHosts(material.appliesToHosts.join(', '));
    } else {
      setUsername('');
      setHeaderName('');
      setNotes('');
      setHosts('');
    }
    setPassword('');
    setHeaderValue('');
  }, [isOpen, material]);

  const isPending = createMutation.isPending || updateMutation.isPending;
  const isCredential = kind === 'login_credential';

  const title = isEditing
    ? `Edit ${isCredential ? 'Credential' : 'Header'}`
    : `New ${isCredential ? 'Credential' : 'Header'}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isEditing && material) {
      // Update
      if (isCredential) {
        await updateMutation.mutateAsync({
          scopeId,
          materialId: material.id,
          kind: 'login_credential',
          username: username.trim() || undefined,
          password: password.trim() || undefined,
          notes: notes.trim() || undefined,
          appliesToHosts: parseHosts(hosts),
        });
      } else {
        await updateMutation.mutateAsync({
          scopeId,
          materialId: material.id,
          kind: material.kind,
          headerName: headerName.trim() || undefined,
          headerValue: headerValue.trim() || undefined,
          notes: notes.trim() || undefined,
          appliesToHosts: parseHosts(hosts),
        });
      }
    } else {
      // Create
      if (isCredential) {
        await createMutation.mutateAsync({
          scopeId,
          kind: 'login_credential',
          username: username.trim(),
          password: password.trim(),
          notes: notes.trim() || undefined,
          appliesToHosts: parseHosts(hosts),
        });
      } else {
        await createMutation.mutateAsync({
          scopeId,
          kind: 'custom_header',
          headerName: headerName.trim(),
          headerValue: headerValue.trim(),
          notes: notes.trim() || undefined,
          appliesToHosts: parseHosts(hosts),
        });
      }
    }
    onClose();
  };

  return (
    <Modal 
      isOpen={isOpen} 
      onClose={onClose} 
      title={title} 
      size="md"
    >
      <form onSubmit={handleSubmit}>
        {/* Info Banner */}
        <div className="mx-6 mb-8 mt-6 flex items-center gap-3 border-l-2 border-border py-2 pl-4">
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {isEditing 
              ? 'Sensitive fields are masked. Leave blank to keep existing encrypted values.' 
              : 'All materials are encrypted at rest and never transmitted in plain text.'}
          </p>
        </div>

        {/* Fields */}
        <div className="px-6 pb-1 space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-8">
            {isCredential ? (
              <>
                <div className="space-y-1.5">
                  <Label className={labelClass}>Username/Email</Label>
                  <Input 
                    required 
                    value={username} 
                    onChange={(e) => setUsername(e.target.value)} 
                    placeholder="tester@example.com" 
                    className={inputClass} 
                    autoFocus 
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className={labelClass}>Password</Label>
                  <Input 
                    type="password" 
                    required={!isEditing} 
                    value={password} 
                    onChange={(e) => setPassword(e.target.value)} 
                    placeholder={isEditing ? '••••••••' : 'Secret password'} 
                    className={inputClass} 
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label className={labelClass}>Header Name</Label>
                  <Input 
                    required 
                    value={headerName} 
                    onChange={(e) => setHeaderName(e.target.value)} 
                    placeholder="Authorization" 
                    className={inputClass} 
                    autoFocus 
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className={labelClass}>Header Value</Label>
                  <Input 
                    type="password" 
                    required={!isEditing} 
                    value={headerValue} 
                    onChange={(e) => setHeaderValue(e.target.value)} 
                    placeholder={isEditing ? '••••••••' : 'Bearer eyJhbG...'} 
                    className={inputClass} 
                  />
                </div>
              </>
            )}
            
            <div className="space-y-1.5 md:col-span-2">
              <Label className={labelClass}>Bound Host(s) (optional)</Label>
              <Input
                value={hosts}
                onChange={(e) => setHosts(e.target.value)}
                placeholder="e.g. app.target.net, *.target.net"
                className={inputClass}
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label className={labelClass}>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="When/where to use this material"
                className="min-h-[100px] resize-none p-4"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={isPending}>
            {isPending ? 'Saving' : isEditing ? 'Update' : 'Save material'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
