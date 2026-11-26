import { DetailSection, SectionPanel } from '@null-ai/design-tokens/ui';
import type { CanonicalRiskDetail } from '@/modules/security-ops/types';

/**
 * The source half of a Risk.
 *
 * One lifecycle produced these records, but not one kind of proof: an
 * assessment proves a Risk by reaching it, a code review proves it by pointing
 * at the line, and a verified advisory proves it by matching a component and
 * then confirming it. The state ladder above these panels is identical; what
 * differs is the evidence, so that is the only thing that branches.
 *
 * `sourceDetailsRestricted` is a plan gate, not an error — the Risk is real
 * and the customer can see it, they just cannot open the source behind it.
 * That reads as locked, which the brand keeps legible, rather than absent.
 */

const LockedNote = ({ what }: { what: string }) => (
  <p className="text-sm text-muted-foreground">
    {what} is available on plans that include this source. The Risk itself,
    its severity and its state are unaffected.
  </p>
);

const formatDate = (value: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export function CodeSourcePanel({ risk }: { risk: CanonicalRiskDetail }) {
  if (risk.sourceKind !== 'code_review') return null;

  if (risk.sourceDetailsRestricted || !risk.codeOccurrence) {
    return (
      <SectionPanel title="Code occurrence">
        <LockedNote what="The commit, the affected lines and the fix assessment" />
      </SectionPanel>
    );
  }

  const occurrence = risk.codeOccurrence;

  return (
    <>
      <SectionPanel title="Code occurrence">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <DetailSection label="Repository">
            <span className="font-mono text-sm">{occurrence.repositoryFullName}</span>
          </DetailSection>
          <DetailSection label="Commit">
            {/* A commit SHA is real data, and only the first 12 are readable. */}
            <span className="font-mono text-sm" title={occurrence.commitSha}>
              {occurrence.commitSha.slice(0, 12)}
            </span>
          </DetailSection>
        </div>

        <DetailSection label={occurrence.locations.length === 1 ? 'Location' : 'Locations'}>
          <ul className="space-y-1.5">
            {occurrence.locations.map((location, index) => (
              <li key={`${location.filePath}-${index}`} className="font-mono text-sm">
                {location.filePath}
                {location.startLine != null ? (
                  <span className="text-muted-foreground">
                    :{location.startLine}
                    {location.endLine != null && location.endLine !== location.startLine
                      ? `-${location.endLine}`
                      : ''}
                  </span>
                ) : null}
                {location.symbol ? (
                  <span className="text-muted-foreground"> · {location.symbol}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </DetailSection>
      </SectionPanel>

      <SectionPanel title="Attribution">
        <DetailSection label="Introduced by">{occurrence.changeAttribution}</DetailSection>
        {occurrence.attributionRationale ? (
          <DetailSection label="Why">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {occurrence.attributionRationale}
            </p>
          </DetailSection>
        ) : null}
      </SectionPanel>

      <SectionPanel title="Fix">
        <DetailSection label="Fixability">{occurrence.fixability}</DetailSection>
        {occurrence.fixabilityRationale ? (
          <DetailSection label="Assessment">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {occurrence.fixabilityRationale}
            </p>
          </DetailSection>
        ) : null}
      </SectionPanel>
    </>
  );
}

export function ExposureSourcePanel({ risk }: { risk: CanonicalRiskDetail }) {
  if (risk.sourceKind !== 'advisory_verification') return null;

  if (risk.sourceDetailsRestricted || !risk.exposureSource) {
    return (
      <SectionPanel title="Advisory">
        <LockedNote what="The advisory, the affected component and its verification history" />
      </SectionPanel>
    );
  }

  const source = risk.exposureSource;

  return (
    <SectionPanel title="Advisory">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <DetailSection label="Advisory">
          <span className="font-mono text-sm">{source.advisoryId}</span>
        </DetailSection>
        <DetailSection label="Component">
          <span className="font-mono text-sm">
            {source.componentName}
            {source.componentVersion ? `@${source.componentVersion}` : ''}
          </span>
        </DetailSection>
        <DetailSection label="Verified">{formatDate(source.verifiedAt)}</DetailSection>
      </div>
    </SectionPanel>
  );
}
