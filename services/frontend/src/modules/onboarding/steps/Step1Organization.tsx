import { Input } from '@null-ai/design-tokens/ui';
import type { SetupFormData } from '../types';

export default function Step1Organization({
  data,
  updateData,
}: {
  data: SetupFormData;
  updateData: (data: Partial<SetupFormData>) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 ">
      <Input
        id="orgName"
        aria-label="Organization name"
        value={data.orgName}
        onChange={(event) => updateData({ orgName: event.target.value })}
        placeholder="Acme Inc."
        autoComplete="organization"
        autoFocus
        className="h-14 px-6 text-center text-base font-medium text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus-visible:ring-0"
      />
    </div>
  );
}
