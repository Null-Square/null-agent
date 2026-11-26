import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateScopeMutation } from '@/modules/security-ops/api';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { Button, Input, Label, Modal, ModalContent, ModalFooter } from '@null-ai/design-tokens/ui';
import { toApiError } from '@shared/lib/apiError';

interface CreateScopeModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CreateScopeModal({ open, onClose }: CreateScopeModalProps) {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const createScope = useCreateScopeMutation();

  const [name, setName] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setSubmitError(null);
      return;
    }

    setSubmitError(null);
  }, [open]);

  const handleCreate = () => {
    if (!name.trim()) return;

    setSubmitError(null);

    createScope.mutate(
      {
        name: name.trim(),
      },
      {
        onSuccess: (scope) => {
          onClose();
          navigate(paths.scopeDetail(scope.id));
        },
        onError: (error) => {
          const apiError = toApiError(error);
          setSubmitError(apiError.userMessage || apiError.message || 'Failed to create scope.');
        },
      },
    );
  };

  if (!open) return null;

  return (
    <Modal isOpen={open} onClose={onClose} title="Create new scope" size="sm">
        <ModalContent className="space-y-6">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Name the environment you want assessed. Add and verify one domain; by default
              that domain and all of its subdomains are included. You can then exclude only
              the namespaces that must not be tested and authorize the assessment.
            </p>
            {submitError ? (
              <div role="alert" className="border border-destructive/40 bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
                {submitError}
              </div>
            ) : null}
            {/* Name */}
            <div className="space-y-2">
                <Label htmlFor="scope-name">Scope name</Label>
                <Input
                    id="scope-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Production API, Staging Web App"
                    className="font-mono"
                    autoFocus
                />
            </div>


        </ModalContent>

        <ModalFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            loading={createScope.isPending}
            disabled={!name.trim()}
          >
            {createScope.isPending ? 'Creating' : 'Create scope'}
          </Button>
        </ModalFooter>
    </Modal>
  );
}
