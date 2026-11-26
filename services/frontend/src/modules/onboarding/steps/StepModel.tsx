import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@null-ai/design-tokens/ui';
import { ModelConnect, useModelConnectionQuery } from '@modules/model';

/**
 * Setup's first step: how Null thinks. A model that is already connected (a
 * key in `.env`, or an earlier visit) is shown as it is, with a way to change it.
 */
export default function StepModel() {
  const [searchParams] = useSearchParams();
  const { data: overview, isLoading } = useModelConnectionQuery();
  // Back from ChatGPT, the choices are open so the outcome can be read there.
  const [changing, setChanging] = useState(() => searchParams.has('chatgpt'));
  const connection = overview?.connection ?? null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
        <span className="ns-live-mark" aria-hidden />
        Looking for a model
      </div>
    );
  }

  if (connection && !changing) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3">
        <p className="flex items-center gap-2 font-mono text-sm text-success" role="status">
          <span className="h-[7px] w-[7px] flex-none bg-current" aria-hidden />
          Connected: {connection.label}
        </p>
        <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <ModelConnect returnTo="/setup" />
    </div>
  );
}
