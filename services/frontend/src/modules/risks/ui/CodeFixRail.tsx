import { Button, DetailRailField, DetailRailNote } from '@null-ai/design-tokens/ui';
import {
  useRequestCodeReviewFixMutation,
  useRunCodeReviewQuery,
} from '@/modules/security-ops/api';
import { toastService } from '@shared/services/toastService';
import type { CanonicalRiskDetail } from '@/modules/security-ops/types';

/**
 * Fix, for a code Risk.
 *
 * This was the one thing the separate code-review page had that the Risk
 * detail did not — impact, remediation, source evidence and validation were
 * already the same anatomy under a different roof. So it moves here, and the
 * second page is left with nothing of its own.
 *
 * It stays a rail block rather than a section: the rail is where a page keeps
 * the verb, and Fix is the only verb a code Risk offers.
 */

const terminalRetryableStatuses = new Set(['failed', 'rejected', 'expired']);

const humanize = (value: string): string =>
  value.replace(/_/g, ' ').replace(/^\w/, (character) => character.toUpperCase());

export function CodeFixRail({ risk }: { risk: CanonicalRiskDetail }) {
  const occurrence = risk.codeOccurrence;
  const { data: bundle } = useRunCodeReviewQuery(occurrence?.runId ?? '', {
    enabled: Boolean(occurrence?.runId),
  });
  const requestFix = useRequestCodeReviewFixMutation();

  if (!occurrence) return null;

  const currentFixRequest = bundle?.fixRequests?.find(
    (request) =>
      request.findingId === occurrence.id
      && request.findingVersion === occurrence.version
      && !terminalRetryableStatuses.has(request.status),
  );

  // Fix is offered on a confirmed Risk the agent judged fixable, and only when
  // no attempt is already in flight.
  const canRequestFix =
    risk.state === 'confirmed'
    && occurrence.fixability === 'fixable'
    && !currentFixRequest;

  const handleFix = () => {
    requestFix.mutate(
      {
        runId: occurrence.runId,
        findingId: occurrence.id,
        findingVersion: occurrence.version,
        vulnerableCommitSha: occurrence.commitSha,
      },
      {
        onSuccess: () =>
          toastService.success(
            'Fix requested. Patch generation and publication remain separately gated.',
          ),
        onError: () => toastService.error('Could not request a fix for this risk.'),
      },
    );
  };

  return (
    <>
      <DetailRailField label="Fixability">{humanize(occurrence.fixability)}</DetailRailField>
      {occurrence.fixabilityRationale ? (
        <DetailRailNote>{occurrence.fixabilityRationale}</DetailRailNote>
      ) : null}

      {canRequestFix ? (
        <Button className="w-full justify-center" disabled={requestFix.isPending} onClick={handleFix}>
          {requestFix.isPending ? 'Requesting' : 'Fix it'}
        </Button>
      ) : null}

      {currentFixRequest ? (
        <DetailRailNote role="status" title={`Fix ${humanize(currentFixRequest.status)}`}>
          Patch generation and publication remain separately gated.
        </DetailRailNote>
      ) : null}
    </>
  );
}
