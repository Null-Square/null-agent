import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@null-ai/design-tokens/ui';
import { setScopeFolder } from './localAccount';

export function LocalScopeFolderPanel({ scopeId, folder }: { scopeId: string; folder: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<'choose' | 'clear' | null>(null);
  const [error, setError] = useState('');

  async function change(selection: 'choose' | 'clear') {
    if (pending) return;
    setPending(selection);
    setError('');
    try {
      await setScopeFolder(scopeId, selection);
      await queryClient.invalidateQueries({ queryKey: ['local-owner'] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save the local folder.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      {folder && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Selected folder</p>
          <p className="break-all border border-border px-3 py-2 font-mono text-sm">{folder}</p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={pending !== null} onClick={() => void change('choose')}>
          {pending === 'choose' ? 'Waiting for folder selection…' : folder ? 'Change folder' : 'Select folder'}
        </Button>
        {folder && (
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void change('clear')}>
            Clear path
          </Button>
        )}
      </div>
    </div>
  );
}
