import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  CellIcon,
  DetailRailField,
  IdentityBand,
  RailLayout,
  Input,
  Label,
  SectionPanel,
  StatusTabs,
  Textarea,
} from '@null-ai/design-tokens/ui';
import {
  useOrganizationQuery,
  useUpdateOrganizationMutation,
} from '@/modules/security-ops/api';
import type { Organization } from '@/modules/security-ops/types';
import SettingsLayout from '@/modules/settings/ui/SettingsLayout';
import { toastService } from '@shared/services/toastService';
import { toApiError } from '@shared/lib/apiError';
import { cn } from '@/shared/lib/utils';
import { useOrgPermissions } from '@modules/permissions';
import { ModelSettingsPanel } from '@modules/model';
import { useAppPaths } from '@shared/contexts/AppPathContext';

const normalizeDocument = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const toNullableDocument = (value: string | null | undefined): string | null => {
  const normalized = normalizeDocument(value);
  return normalized.length > 0 ? normalized : null;
};

/* Matches `MAX_ORGANIZATION_BRIEF_LENGTH` in organization.router.ts. */
const MAX_ORGANIZATION_BRIEF_LENGTH = 500;

export default function OrganizationPage() {
  const { data: org } = useOrganizationQuery();
  const updateOrg = useUpdateOrganizationMutation();

  const [form, setForm] = useState<Partial<Organization>>({});
  const briefLength = (form.operationalContext ?? '').length;
  const isBriefOverLimit = briefLength > MAX_ORGANIZATION_BRIEF_LENGTH;
  const [dirty, setDirty] = useState(false);

  const permissions = useOrgPermissions();
  const paths = useAppPaths();
  const [searchParams] = useSearchParams();
  // ChatGPT sends the browser back to Settings with `?chatgpt=`: open the Model tab.
  const [tab, setTab] = useState(() => (searchParams.has('chatgpt') ? 'model' : 'general'));

  useEffect(() => {
    if (org) {
      setForm({
        name: org.name,
        operationalContext: org.operationalContext,
      });
      setDirty(false);
    }
  }, [org]);

  const handleChange = useCallback(<K extends keyof Organization>(field: K, value: Organization[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(() => {
    /* The cap dropped from 4,000 to 500 when the brief stopped being a composed
       document, so an organization written under the old wizard can be over it.
       Refuse here with the reason, rather than letting the API reject the whole
       save — including a rename that has nothing to do with the brief. */
    if ((form.operationalContext ?? '').trim().length > MAX_ORGANIZATION_BRIEF_LENGTH) {
      toastService.error(
        'Description is too long',
        `Shorten it to ${MAX_ORGANIZATION_BRIEF_LENGTH} characters or fewer before saving.`,
      );
      return;
    }
    const normalizedOrganizationBrief = toNullableDocument(form.operationalContext);
    const payload: Partial<Organization> = {
      name: form.name,
      operationalContext: normalizedOrganizationBrief,
    };
    updateOrg.mutate(payload, {
      onSuccess: () => {
        toastService.success('Settings Saved', 'Organization details updated.');
        setDirty(false);
      },
      onError: (error) => {
        const apiError = toApiError(error);
        toastService.error('Save Failed', apiError.message || 'Could not update organization.');
      }
    });
  }, [form, updateOrg]);

  if (!org) return null;

  const canEditOrg = permissions.has('org.settings.write');
  const tabs = [
    { value: 'general', label: 'Organization', icon: <CellIcon name="orgs" size={15} /> },
    { value: 'model', label: 'Model', icon: <CellIcon name="integrations" size={15} /> },
  ];

  return (
    <>
      <SettingsLayout title="Settings">
        <div className="space-y-8 font-sans">
            {/* No id under the name: the sidebar already carries it, and an
                identifier is not what someone reads a page heading for. */}
            <IdentityBand glyph="orgs" name={org.name} />

            <StatusTabs
                items={tabs}
                value={tab}
                onChange={setTab}
                tone="bone"
                aria-label="Settings sections"
                className="mb-8"
            />

            {tab === 'model' ? <ModelSettingsPanel returnTo={paths.settingsHome} /> : null}

            {/* TAB: GENERAL */}
            {tab === 'general' ? (
            <RailLayout
                rail={
                    <>
                        <DetailRailField label="Organization ID">
                            <span className="select-all break-all font-mono text-sm">{org.id}</span>
                        </DetailRailField>
                        {!canEditOrg && (
                            <DetailRailField label="Access">
                                Read-only — editing requires{' '}
                                <span className="font-mono">org.settings.write</span>
                            </DetailRailField>
                        )}
                    </>
                }
            >
              <div className="space-y-8">
                <SectionPanel
                    title="Organization details"
                    actions={
                        <Button
                            size="sm"
                            onClick={handleSave}
                            disabled={!dirty || updateOrg.isPending || !canEditOrg}
                            title={!canEditOrg ? 'Your role does not permit editing organization settings.' : undefined}
                        >
                            {updateOrg.isPending ? 'Saving' : 'Save changes'}
                        </Button>
                    }
                >
                    <div className="space-y-6">
                    <div className="space-y-2">
                        <Label htmlFor="org-name">Organization name</Label>
                        <Input
                            id="org-name"
                            value={form.name ?? ''}
                            onChange={(e) => handleChange('name', e.target.value)}
                            placeholder="e.g. Acme HQ"
                        />
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-baseline justify-between gap-4">
                            <Label htmlFor="org-brief">What this company does</Label>
                            <span
                                className={cn(
                                    'font-mono text-[11px]',
                                    isBriefOverLimit ? 'text-destructive' : 'text-muted-foreground',
                                )}
                            >
                                {briefLength}/{MAX_ORGANIZATION_BRIEF_LENGTH}
                            </span>
                        </div>
                        <Textarea
                            id="org-brief"
                            value={form.operationalContext ?? ''}
                            maxLength={MAX_ORGANIZATION_BRIEF_LENGTH}
                            disabled={!canEditOrg}
                            onChange={(e) => handleChange('operationalContext', e.target.value)}
                            placeholder="A payments company running a customer portal and an internal admin app."
                            className="h-24"
                        />
                        <p className={cn('text-sm', isBriefOverLimit ? 'text-destructive' : 'text-muted-foreground')}>
                            {isBriefOverLimit
                                ? `This description predates the ${MAX_ORGANIZATION_BRIEF_LENGTH}-character limit. Shorten it to save any change on this page.`
                                : "One or two lines, so agents know what they are looking at. What may be tested and how far belongs to each scope's rules of engagement."}
                        </p>
                    </div>
                    </div>
                </SectionPanel>
              </div>
            </RailLayout>
            ) : null}
        </div>
      </SettingsLayout>
    </>
  );
}
