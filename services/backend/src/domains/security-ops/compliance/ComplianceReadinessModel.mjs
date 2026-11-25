const toIsoString = (value)=>{
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const dateMs = (value)=>{
    const iso = toIsoString(value);
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
};

const statusWeight = (status)=>{
    switch(status){
        case 'passing':
            return 100;
        case 'partial':
            return 0;
        case 'stale':
            return 0;
        case 'accepted_risk':
            return 0;
        case 'failing':
            return 0;
        case 'missing':
            return 0;
        case 'not_applicable':
        case 'not_supported':
            return null;
        default:
            return null;
    }
};
const emptyStatusCounts = ()=>({
        missing: 0,
        partial: 0,
        passing: 0,
        failing: 0,
        stale: 0,
        accepted_risk: 0,
        not_applicable: 0,
        not_supported: 0
    });
const emptyOutcomeCounts = ()=>({
        passed: 0,
        failed: 0,
        needs_action: 0,
        not_checked: 0,
        excluded: 0
    });
const emptyVerdictCounts = ()=>({
        pass: 0,
        fail: 0,
        needs_evidence: 0,
        needs_context: 0,
        not_attempted: 0,
        accepted_risk: 0,
        not_applicable: 0,
        not_supported: 0
    });
const computeQuality = (flags)=>{
    const values = [
        flags.traceable,
        flags.fresh,
        flags.trustedSource,
        flags.scopeComplete,
        flags.humanReviewed
    ];
    return {
        ...flags,
        score: Math.round(values.filter(Boolean).length / values.length * 100)
    };
};
const dedupeEvidence = (evidence)=>{
    const seen = new Set();
    const rows = [];
    for (const item of evidence){
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        rows.push(item);
    }
    return rows.sort((left, right)=>{
        const leftMs = dateMs(left.lastSeenAt) ?? 0;
        const rightMs = dateMs(right.lastSeenAt) ?? 0;
        return rightMs - leftMs || left.id.localeCompare(right.id);
    }).slice(0, 12);
};
const deriveControlStatus = (definition, evidence)=>{
    if (definition.supportLevel === 'out_of_selected_scope') return 'not_supported';
    const freshControlChecks = evidence.filter((item)=>item.kind === 'agent_control_check' && item.quality.fresh);
    if (freshControlChecks.some((item)=>item.negative === true)) return 'failing';
    if (evidence.some((item)=>item.kind === 'accepted_risk')) return 'accepted_risk';
    if (freshControlChecks.some((item)=>item.controlCheckVerdict === 'pass')) return 'passing';
    if (evidence.length === 0) return 'missing';
    const passingEligibleEvidence = evidence.filter((item)=>item.mappingConfidence !== 'low');
    const freshCount = evidence.filter((item)=>item.quality.fresh).length;
    const approvedUserEvidenceCount = passingEligibleEvidence.filter((item)=>item.kind === 'user_evidence' && item.quality.fresh && item.quality.traceable && item.quality.trustedSource && item.quality.humanReviewed).length;
    if (definition.supportLevel === 'manual_evidence_required' || definition.supportLevel === 'integration_required') {
        if (approvedUserEvidenceCount > 0) return 'passing';
        if (passingEligibleEvidence.some((item)=>item.kind === 'user_evidence' && item.quality.humanReviewed && item.quality.traceable) && freshCount === 0) {
            return 'stale';
        }
        return 'partial';
    }
    const hasAnyControlCheck = evidence.some((item)=>item.kind === 'agent_control_check');
    if (hasAnyControlCheck && freshControlChecks.length === 0) return 'stale';
    if (freshCount === 0) return 'stale';
    return 'partial';
};
const deriveControlVerdict = (status, checks)=>{
    if (status === 'passing') return 'pass';
    if (status === 'failing') return 'fail';
    if (status === 'accepted_risk') return 'accepted_risk';
    if (status === 'not_applicable') return 'not_applicable';
    if (status === 'not_supported') return 'not_supported';
    if (checks.some((check)=>check.eligible && check.fresh && check.verdict === 'needs_context')) return 'needs_context';
    if (status === 'stale') return 'needs_evidence';
    return 'not_attempted';
};
const outcomeForControl = (verdict, actionRequests)=>{
    if (actionRequests.some((request)=>[
            'open',
            'fulfilled',
            'insufficient',
            'contradicted'
        ].includes(request.status))) {
        return 'needs_action';
    }
    if (verdict === 'pass') return 'passed';
    if (verdict === 'fail') return 'failed';
    if (verdict === 'not_applicable' || verdict === 'not_supported') return 'excluded';
    if (verdict === 'needs_context' || verdict === 'needs_evidence') return 'needs_action';
    return 'not_checked';
};
const NIST_CSF_FUNCTIONS = [
    'Govern',
    'Identify',
    'Protect',
    'Detect',
    'Respond',
    'Recover'
];
const buildNistCsfReadinessProfile = (controls)=>({
        kind: 'nist_csf_2_0',
        functions: NIST_CSF_FUNCTIONS.map((functionName)=>{
            const functionControls = controls.filter((control)=>control.theme === functionName);
            const outcomeCounts = emptyOutcomeCounts();
            for (const control of functionControls){
                outcomeCounts[control.outcome] += 1;
            }
            return {
                function: functionName,
                total: functionControls.length,
                monitored: functionControls.filter((control)=>control.monitoring.state === 'monitored').length,
                directCheckCount: functionControls.filter((control)=>control.controlChecks.length > 0).length,
                outcomeCounts
            };
        }),
        implementationTier: {
            status: 'not_determined',
            tier: null,
            reason: 'Implementation Tier is not derived from readiness counts. It requires organization-owned Current Profile and governance evidence.'
        }
    });
const buildFrameworkSummary = (input)=>{
    const statusCounts = emptyStatusCounts();
    const outcomeCounts = emptyOutcomeCounts();
    const verdictCounts = emptyVerdictCounts();
    const scoreValues = [];
    for (const control of input.controls){
        statusCounts[control.status] += 1;
        outcomeCounts[control.outcome] += 1;
        verdictCounts[control.verdict] += 1;
        const weight = statusWeight(control.status);
        if (weight !== null) scoreValues.push(weight);
    }
    const score = input.supported && scoreValues.length > 0 ? Math.round(scoreValues.reduce((sum, value)=>sum + value, 0) / scoreValues.length) : 0;
    return {
        key: input.key,
        label: input.label,
        selected: input.selected,
        supported: input.supported,
        score,
        statusCounts,
        outcomeCounts,
        verdictCounts,
        controls: input.controls,
        gaps: input.controls.flatMap((control)=>control.gaps).slice(0, 12),
        coverageLimitations: Array.from(new Set(input.controls.flatMap((control)=>control.coverageLimitations))).slice(0, 8)
    };
};
export { computeQuality, dedupeEvidence, deriveControlStatus, deriveControlVerdict, outcomeForControl, buildNistCsfReadinessProfile, buildFrameworkSummary };
