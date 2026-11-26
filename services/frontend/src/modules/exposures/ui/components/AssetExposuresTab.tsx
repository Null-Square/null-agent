import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useExposuresQuery, useVerifyExposureMutation } from '@/modules/security-ops/api';
import { Button, RecordTable, SeverityBadge, severityTone,
  ExposureStateBadge,
  KevBadge,
  MatchCaveatBadge,
} from '@null-ai/design-tokens/ui';

// CVSS is graded by the severity ramp — see FindingsPage.
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useHasCapability } from '@/modules/permissions';
import {
  ExposureVerificationDialog,
  type ExposureVerificationTarget,
} from './ExposureVerificationDialog';

const OPEN_STATES = ['candidate', 'notified', 'verifying', 'inconclusive'];

/**
 * Exposures for a single asset.
 *
 * Filtered client-side on the asset's value because the list endpoint is
 * organization-wide by design — an asset can be watched by more than one scope,
 * so the server deliberately does not narrow by scope. The list is capped
 * server-side, which keeps this honest for the sizes this page sees; if that
 * cap is ever raised, this needs a real server-side filter rather than a
 * larger client-side one.
 */
export function AssetExposuresTab({ assetValue }: { assetValue: string }) {
  const [verificationTarget, setVerificationTarget] = useState<ExposureVerificationTarget | null>(null);
  const navigate = useNavigate();
  const paths = useAppPaths();
  const canVerify = useHasCapability('org.run.start');
  const { data: exposures, isLoading, isError } = useExposuresQuery();
  const verify = useVerifyExposureMutation();

  const rows = (exposures ?? []).filter((row) => row.assetValue === assetValue);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <span aria-hidden className="ns-live-mark mr-2 h-2 w-2 bg-current" />
        <span className="font-mono text-[10px] uppercase tracking-widest">Loading advisory risks</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="border-l-2 border-destructive py-3 pl-5 text-sm text-muted-foreground">
        Advisory risks could not be loaded. Try again shortly.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="border border-dashed border-border/70 p-12 text-center">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          No advisories match the software recorded on this asset.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Every list is the one data table — this tab was boxing each exposure
          as its own rounded, shadowed card. */}
      <RecordTable
        rows={rows}
        getRowKey={(row) => row.id}
        titleHeader="Risk"
        titleWidth="minmax(0,1.7fr)"
        stripe={(row) => row.severity ?? 'medium'}
        title={(row) =>
          `${row.advisoryId} in ${row.componentName}${row.componentVersion ? ` ${row.componentVersion}` : ''}`
        }
        subtitle={(row) => (
          <span className="flex flex-wrap items-center gap-2">
            <ExposureStateBadge state={row.state} />
            {row.kevListed ? <KevBadge /> : null}
            {row.backportRisk ? <MatchCaveatBadge kind="backport" /> : null}
            {row.versionConflict ? <MatchCaveatBadge kind="conflict" /> : null}
          </span>
        )}
        rowActionLabel={(row) => `Open advisory risk: ${row.advisoryId}`}
        onRowClick={(row) => navigate(paths.exposureDetail(row.id))}
        columns={[
          {
            key: 'severity',
            header: 'Severity',
            width: '110px',
            render: (row) => <SeverityBadge severity={row.severity ?? 'medium'} />,
            showOnMobile: true,
          },
          {
            key: 'cvss',
            header: 'CVSS',
            width: '80px',
            mono: true,
            align: 'end',
            render: (row) => (
              <span className={severityTone(row.severity)}>
                {row.cvssScore != null ? row.cvssScore.toFixed(1) : '—'}
              </span>
            ),
          },
        ]}
        actions={(row) =>
          canVerify && OPEN_STATES.includes(row.state) && row.state !== 'verifying' ? (
            <Button
              size="sm"
              variant="outline"
              loading={verify.isPending && verify.variables === row.id}
              onClick={() =>
                setVerificationTarget({
                  id: row.id,
                  advisoryId: row.advisoryId,
                  assetValue: row.assetValue,
                })
              }
            >
              Verify advisory risk
            </Button>
          ) : null
        }
      />
      <ExposureVerificationDialog
        target={verificationTarget}
        onCancel={() => setVerificationTarget(null)}
        onConfirm={() => {
          if (!verificationTarget) return;
          verify.mutate(verificationTarget.id);
          setVerificationTarget(null);
        }}
      />
    </>
  );
}
