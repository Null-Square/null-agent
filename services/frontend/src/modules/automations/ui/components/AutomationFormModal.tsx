import { useEffect, useMemo, useState } from 'react';
import {
  useCreateAutomationMutation,
  useUpdateAutomationMutation,
  type Automation,
} from '@/modules/security-ops/api';
import type { ComplianceFrameworkKey, ExecutionTarget, RunWorkflowDiscipline } from '@/modules/security-ops/types';
import {
  COMPLIANCE_FRAMEWORK_OPTIONS,
  COMPLIANCE_FRAMEWORK_SHORT_LABELS,
} from '@/modules/security-ops/complianceFrameworks';
import { useScope } from '@shared/contexts/ScopeContext';
import { getModelEffortLabel, useAvailableModelsQuery } from '@/modules/sessions/api';
import { toastService } from '@shared/services/toastService';
import { toApiError } from '@shared/lib/apiError';
import { Clock, Target, Shield, Info, ChevronLeft, CheckCircle2, ClipboardCheck } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { ExecutionTargetSelector } from '@shared/ui/ExecutionTargetSelector';
import { Modal, ModalContent, ModalFooter } from '@null-ai/design-tokens/ui';

interface AutomationFormModalProps {
  open: boolean;
  onClose: () => void;
  automation?: Automation | null;
}

const DAYS_OF_WEEK = [
  { short: 'S', value: 0 },
  { short: 'M', value: 1 },
  { short: 'T', value: 2 },
  { short: 'W', value: 3 },
  { short: 'T', value: 4 },
  { short: 'F', value: 5 },
  { short: 'S', value: 6 },
];

const HOURS = Array.from({ length: 12 }, (_, i) => i === 0 ? 12 : i);
const MINUTES = ['00', '15', '30', '45'];

export default function AutomationFormModal({ open, onClose, automation }: AutomationFormModalProps) {
  const { activeScopeId, scopes } = useScope();
  const createAutomation = useCreateAutomationMutation();
  const updateAutomation = useUpdateAutomationMutation();
  const { data: availableModels = [], isLoading: modelsLoading } = useAvailableModelsQuery();

  const [currentStep, setCurrentStep] = useState(1);
  const [name, setName] = useState('');
  const [modelCategory, setModelCategory] = useState('');
  const [workflowDiscipline, setWorkflowDiscipline] = useState<RunWorkflowDiscipline>('pentest');
  const [complianceFrameworkKey, setComplianceFrameworkKey] = useState<ComplianceFrameworkKey>('soc2');
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget>('cloud');
  const [goal, setGoal] = useState('');
  
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [selectedDays, setSelectedDays] = useState<number[]>([1]); 
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState('00');
  const [ampm, setAmpm] = useState<'AM' | 'PM'>('AM');
  const [timezone] = useState('UTC');
  const [isActive, setIsActive] = useState(true);
  
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isEditing = Boolean(automation);
  const isPending = createAutomation.isPending || updateAutomation.isPending;
  
  
  const defaultModelCategory = useMemo(
    () => availableModels.find((model) => model.isDefault)?.id ?? availableModels[0]?.id ?? '',
    [availableModels],
  );
  const selectedScopeId = automation?.scopeId ?? activeScopeId ?? '';
  const selectedScope = useMemo(
    () => scopes.find((scope) => scope.id === selectedScopeId) ?? null,
    [scopes, selectedScopeId],
  );
  const attachedRunner = selectedScope?.attachedRunner ?? null;
  const assignedComplianceFrameworkOptions = useMemo(() => {
    const assignedFrameworks = new Set(selectedScope?.complianceFrameworks ?? []);
    return COMPLIANCE_FRAMEWORK_OPTIONS.filter((option) => assignedFrameworks.has(option.key));
  }, [selectedScope?.complianceFrameworks]);
  const hasSelectedAssignedComplianceFramework = assignedComplianceFrameworkOptions.some(
    (option) => option.key === complianceFrameworkKey,
  );
  const selectedComplianceFrameworkLabel =
    hasSelectedAssignedComplianceFramework
      ? COMPLIANCE_FRAMEWORK_SHORT_LABELS[complianceFrameworkKey] ?? complianceFrameworkKey.toUpperCase()
      : null;
  const canUseAttachedRunner = Boolean(attachedRunner);

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setCurrentStep(1);

    if (automation) {
      setName(automation.name);
      setModelCategory(automation.modelCategory ?? '');
      setWorkflowDiscipline(automation.workflowDiscipline ?? 'pentest');
      setComplianceFrameworkKey(automation.complianceFrameworkKey ?? 'soc2');
      setExecutionTarget(automation.executionTarget ?? 'cloud');
      setGoal(automation.goal);
      setIsActive(automation.isActive);

      if (automation.triggerConfig.type === 'scheduled') {
        const cron = automation.triggerConfig.cron;
        if (cron === '0 0 * * *') setFrequency('daily');
        else if (cron.includes(' * * ')) {
             setFrequency('weekly');
             const parts = cron.split(' ');
             const day = parseInt(parts[4]);
             if (!isNaN(day)) setSelectedDays([day]);
        }
        else if (cron.endsWith(' 1 * *')) setFrequency('monthly');
      }
      return;
    }

    setName('');
    setModelCategory('');
    setWorkflowDiscipline('pentest');
    setComplianceFrameworkKey('soc2');
    setExecutionTarget('cloud');
    setGoal('');
    setFrequency('weekly');
    setSelectedDays([1]);
    setHour(9);
    setMinute('00');
    setAmpm('AM');
    setIsActive(true);
  }, [open, automation]);

  useEffect(() => {
    if (!open) return;
    if (modelCategory || !defaultModelCategory) return;
    setModelCategory(defaultModelCategory);
  }, [defaultModelCategory, modelCategory, open]);

  useEffect(() => {
    if (!canUseAttachedRunner && executionTarget === 'scope_runner') {
      setExecutionTarget('cloud');
    }
  }, [canUseAttachedRunner, executionTarget]);

  useEffect(() => {
    if (!open || assignedComplianceFrameworkOptions.length === 0) return;
    if (hasSelectedAssignedComplianceFramework) return;
    const firstAssignedFramework = assignedComplianceFrameworkOptions[0];
    if (firstAssignedFramework) {
      setComplianceFrameworkKey(firstAssignedFramework.key);
    }
  }, [
    assignedComplianceFrameworkOptions,
    hasSelectedAssignedComplianceFramework,
    open,
  ]);

  const compiledCron = useMemo(() => {
      const hour24 = ampm === 'PM' ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
      if (frequency === 'daily') return `${minute} ${hour24} * * *`;
      if (frequency === 'weekly') return `${minute} ${hour24} * * ${selectedDays.join(',')}`;
      if (frequency === 'monthly') return `${minute} ${hour24} 1 * *`;
      return '0 9 * * 1';
  }, [ampm, frequency, hour, minute, selectedDays]);

  const scheduleSummary = useMemo(() => {
      const timeStr = `${hour}:${minute} ${ampm}`;
      if (frequency === 'daily') return `Every day at ${timeStr} ${timezone}`;
      if (frequency === 'weekly') {
          const names = selectedDays.map(d => DAYS_OF_WEEK.find(dw => dw.value === d)?.short).join(', ');
          return `Weekly on ${names} at ${timeStr} ${timezone}`;
      }
      return `Monthly on the 1st at ${timeStr} ${timezone}`;
  }, [frequency, selectedDays, hour, minute, ampm, timezone]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!name.trim()) {
      toastService.error('Missing field', 'Automation name is required.');
      return;
    }
    if (!selectedScopeId) {
      toastService.error('Missing field', 'Target scope context is missing.');
      return;
    }
    if (!goal.trim()) {
      toastService.error('Missing field', 'Strategic mission goal is required.');
      return;
    }
    if (workflowDiscipline === 'compliance' && !hasSelectedAssignedComplianceFramework) {
      toastService.error('Missing field', 'Assign a compliance framework to this scope before using compliance automations.');
      return;
    }

    if (executionTarget === 'scope_runner' && !attachedRunner) {
      setSubmitError('Attach a private runner to this scope before selecting scope-runner execution.');
      return;
    }

    const payload = {
      name: name.trim(),
      scopeId: selectedScopeId,
      modelCategory,
      workflowDiscipline,
      complianceFrameworkKey: workflowDiscipline === 'compliance' ? complianceFrameworkKey : null,
      executionTarget,
      goal: goal.trim(),
      triggerType: 'scheduled' as const,
      triggerConfig: {
          type: 'scheduled' as const,
          cron: compiledCron,
          timezone,
      },
      isActive,
    };

    const mutation = isEditing
      ? updateAutomation.mutateAsync({ id: automation!.id, ...payload })
      : createAutomation.mutateAsync(payload);

    mutation
      .then(() => {
        toastService.success('Settings Saved', isEditing ? 'Automation updated.' : 'Automation initialized.');
        onClose();
      })
      .catch((error) => {
        const apiError = toApiError(error);
        setSubmitError(apiError.userMessage || apiError.message || 'Operation failed');
      });
  };

  const steps = [
    { id: 1, label: 'Identity', icon: Shield },
    { id: 2, label: 'Strategy', icon: Target },
    { id: 3, label: 'Schedule', icon: Clock },
    { id: 4, label: 'Confirm', icon: CheckCircle2 },
  ];

  const isStep1Valid =
    name.trim().length > 0 &&
    modelCategory !== '' &&
    (workflowDiscipline === 'pentest' || hasSelectedAssignedComplianceFramework);
  const isStep2Valid = goal.trim().length > 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEditing ? 'Configure automation' : 'New automation'}
      size="md"
    >
        {/* Stepper */}
        <div className="border-b border-border px-6 py-5">
            <div className="flex items-center gap-4">
                {steps.map((step) => (
                    <div key={step.id} className="flex-1 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                            <span className={cn(
                                "text-[10px] font-semibold transition-colors",
                                currentStep === step.id ? "text-primary" : currentStep > step.id ? "text-success" : "text-muted-foreground/40"
                            )}>
                                {step.label}
                            </span>
                            {currentStep > step.id && <CheckCircle2 className="h-3 w-3 text-success" />}
                        </div>
                        <div className={cn(
                            "h-1 transition-all duration-500",
                            currentStep >= step.id ? (currentStep > step.id ? "bg-success" : "bg-primary") : "bg-border/40"
                        )} />
                    </div>
                ))}
            </div>
        </div>

        <ModalContent className="min-h-[340px] justify-center">
            
            {/* STEP 1: IDENTITY */}
            {currentStep === 1 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-400">
                    <div className="space-y-5">
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground">Automation name</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. Perimeter Monitor"
                                className="w-full bg-background border border-border/75 h-10 text-xs px-4 text-foreground focus:border-primary outline-none placeholder:text-muted-foreground/45"
                                autoFocus
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-muted-foreground">Agent path</label>
                            <div className={cn("grid gap-2", "grid-cols-2")}>
                                {([
                                    { value: 'pentest', label: 'Pentest', icon: Shield },
                                    { value: 'compliance', label: 'Compliance', icon: ClipboardCheck },
                                ] as const).map((option) => {
                                    const Icon = option.icon;
                                    const selected = workflowDiscipline === option.value;
                                    return (
                                        <button
                                            type="button"
                                            key={option.value}
                                            aria-pressed={selected}
                                            onClick={() => setWorkflowDiscipline(option.value)}
                                            className={cn(
                                                "h-11 border px-3 text-xs font-semibold transition-all inline-flex items-center justify-center gap-2",
                                                selected
                                                    ? "border-primary bg-primary text-primary-foreground"
                                                    : "border-border/60 bg-background text-muted-foreground hover:bg-muted/10 hover:text-foreground"
                                            )}
                                        >
                                            <Icon className="h-3.5 w-3.5" />
                                            {option.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        {workflowDiscipline === 'compliance' && (
                            <div className="space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                                <label className="text-xs font-semibold text-muted-foreground">Compliance framework</label>
                                {assignedComplianceFrameworkOptions.length > 0 ? (
                                    <select
                                        value={hasSelectedAssignedComplianceFramework ? complianceFrameworkKey : assignedComplianceFrameworkOptions[0]?.key ?? complianceFrameworkKey}
                                        onChange={(e) => setComplianceFrameworkKey(e.target.value as ComplianceFrameworkKey)}
                                        className="w-full bg-background border border-border/75 h-10 text-xs px-3 text-foreground focus:border-primary outline-none"
                                    >
                                        {assignedComplianceFrameworkOptions.map((framework) => (
                                            <option key={framework.key} value={framework.key} className="bg-background text-foreground">
                                                {framework.label}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <div className="w-full bg-muted/5 border border-border/75 min-h-10 text-xs px-3 py-2.5 text-muted-foreground">
                                        No compliance frameworks assigned to this scope.
                                    </div>
                                )}
                            </div>
                        )}
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-muted-foreground">Intelligence category</label>
                            <select
                                value={modelCategory}
                                onChange={(e) => setModelCategory(e.target.value)}
                                disabled={modelsLoading}
                                className="w-full bg-background border border-border/75 h-10 text-xs px-3 text-foreground focus:border-primary outline-none"
                            >
                                {availableModels.map((model) => (
                                    <option key={model.id} value={model.id} className="bg-background text-foreground">{getModelEffortLabel(model)}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-muted-foreground">Execution target</label>
                            <div>
                                <ExecutionTargetSelector
                                    value={executionTarget}
                                    onChange={setExecutionTarget}
                                    runnerName={attachedRunner?.name}
                                    className="w-full h-11 text-xs"
                                />
                            </div>
                            <p className="text-[10px] text-muted-foreground font-medium mt-1">
                              {attachedRunner
                                ? `Attached runner available: ${attachedRunner.name} (${attachedRunner.status})`
                                : 'No private runner attached. Runs on this computer only.'}
                            </p>
                        </div>
                    </div>
                    <div className="p-4 bg-primary/5 border border-border/40 flex items-center gap-3">
                         <Shield className="h-4 w-4 text-primary opacity-50" />
                         <div>
                            <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider leading-none mb-1">Targeting context</p>
                            <p className="text-xs font-semibold text-foreground">Active scope: {selectedScope?.name || 'All scopes'}</p>
                         </div>
                    </div>
                </div>
            )}

            {/* STEP 2: STRATEGY */}
            {currentStep === 2 && (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-400">
                    <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-muted-foreground">Strategic mission goal</label>
                        <textarea
                            value={goal}
                            onChange={(e) => setGoal(e.target.value)}
                            rows={6}
                            placeholder="Describe the specialized strategy for this automation..."
                            className="w-full bg-background border border-border/75 p-4 text-xs leading-relaxed min-h-[140px] text-foreground focus:border-primary outline-none placeholder:text-muted-foreground/45 resize-none"
                            autoFocus
                        />
                        <div className="flex items-center gap-1.5 px-1 opacity-60">
                            <Info className="h-3.5 w-3.5 text-muted-foreground" />
                            <p className="text-[10px] text-muted-foreground font-medium">Specific goals enable the security agent to prioritize vulnerabilities better.</p>
                        </div>
                    </div>
                </div>
            )}

            {/* STEP 3: SCHEDULE */}
            {currentStep === 3 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-400">
                    <div className="space-y-5">
                        {/* Frequency */}
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-muted-foreground">Recurrence frequency</label>
                            <div className="flex gap-2">
                                {(['daily', 'weekly', 'monthly'] as const).map(f => (
                                    <button
                                        type="button"
                                        key={f}
                                        onClick={() => setFrequency(f)}
                                        className={cn(
                                            "flex-1 h-10 text-xs font-semibold border transition-all",
                                            frequency === f ? "bg-primary border-primary text-primary-foreground" : "bg-background border-border/60 text-muted-foreground hover:bg-muted/10"
                                        )}
                                    >
                                        {f}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Days (Weekly) */}
                        {frequency === 'weekly' && (
                            <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                                <label className="text-xs font-semibold text-muted-foreground">Active days</label>
                                <div className="flex justify-between gap-1">
                                    {DAYS_OF_WEEK.map(dw => {
                                        const isSelected = selectedDays.includes(dw.value);
                                        return (
                                            <button
                                                type="button"
                                                key={dw.value}
                                                onClick={() => {
                                                    if (isSelected) {
                                                        if (selectedDays.length > 1) setSelectedDays(prev => prev.filter(d => d !== dw.value));
                                                    } else {
                                                        setSelectedDays(prev => [...prev, dw.value].sort());
                                                    }
                                                }}
                                                className={cn(
                                                    "h-8 w-8 flex-1 text-[10px] font-bold transition-all border",
                                                    isSelected ? "bg-foreground border-foreground text-background" : "bg-background border-border/40 text-muted-foreground hover:border-border"
                                                )}
                                            >
                                                {dw.short}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Time & Timezone */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-muted-foreground">Execution time</label>
                                <div className="flex items-center gap-1.5">
                                    <select value={hour} onChange={(e) => setHour(parseInt(e.target.value))} className="h-10 bg-background border border-border/75 text-xs px-2 flex-1 outline-none">
                                        {HOURS.map(h => <option key={h} value={h === 12 ? (ampm === 'AM' ? 12 : 12) : h}>{h}</option>)}
                                    </select>
                                    <select value={minute} onChange={(e) => setMinute(e.target.value)} className="h-10 bg-background border border-border/75 text-xs px-2 w-14 outline-none">
                                        {MINUTES.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                    <button 
                                        type="button"
                                        onClick={() => setAmpm(prev => prev === 'AM' ? 'PM' : 'AM')} 
                                        className="h-10 px-3 bg-muted/10 border border-border/60 text-xs font-semibold text-foreground hover:bg-muted/20 transition-all"
                                    >
                                        {ampm}
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-xs font-semibold text-muted-foreground">Timezone</label>
                                <select value={timezone} disabled className="h-10 bg-muted/10 border border-border/75 text-xs px-3 w-full outline-none text-muted-foreground cursor-not-allowed">
                                    <option value="UTC">UTC (Global default)</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <div className="p-4 bg-muted/5 border border-border/40 flex items-center gap-3">
                        <Clock className="h-4 w-4 text-primary opacity-50" />
                        <p className="text-xs font-semibold text-foreground">{scheduleSummary}</p>
                    </div>
                </div>
            )}

            {/* STEP 4: REVIEW */}
            {currentStep === 4 && (
                <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-400">
                    <div className="space-y-4">
                        <div className="p-4 bg-muted/5 border border-border/40 space-y-3.5">
                             <div className="flex justify-between items-center pb-2 border-b border-border/10">
                                <span className="text-xs text-muted-foreground">Automation handle</span>
                                <span className="text-xs font-semibold text-foreground">{name}</span>
                             </div>
                             <div className="flex justify-between items-center pb-2 border-b border-border/10">
                                <span className="text-xs text-muted-foreground">Agent path</span>
                                <span className="text-xs font-semibold text-foreground">
                                    {workflowDiscipline === 'compliance' ? `Compliance - ${selectedComplianceFrameworkLabel ?? 'Unassigned'}` : 'Pentest'}
                                </span>
                             </div>
                             <div className="flex justify-between items-center pb-2 border-b border-border/10">
                                <span className="text-xs text-muted-foreground">Intelligence Model</span>
                                <span className="text-xs font-semibold text-primary">
                                    {getModelEffortLabel(availableModels.find(m => m.id === modelCategory))}
                                </span>
                             </div>
                             <div className="flex justify-between items-center pb-2 border-b border-border/10">
                                <span className="text-xs text-muted-foreground">Execution Region</span>
                                <span className="text-xs font-semibold text-foreground">
                                  {executionTarget === 'scope_runner' && attachedRunner ? attachedRunner.name : 'This computer'}
                                </span>
                             </div>
                             <div className="flex justify-between items-center pb-2 border-b border-border/10">
                                <span className="text-xs text-muted-foreground">Schedule Sync</span>
                                <span className="text-xs font-semibold text-foreground">{scheduleSummary}</span>
                             </div>
                        </div>

                        {/* Enable Toggle */}
                        <div className="flex items-center justify-between p-4 bg-primary/5 border border-primary/20">
                            <div className="flex items-center gap-2.5">
                                <div className={cn("h-2.5 w-2.5", isActive ? "bg-success" : "bg-muted-foreground/30")} />
                                <div>
                                    <p className="text-xs font-semibold text-foreground">Active scheduling</p>
                                    <p className="text-[10px] text-muted-foreground font-medium opacity-65">{isActive ? 'Background rules are active and running' : 'Background scheduler is paused'}</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsActive(!isActive)}
                                className={cn(
                                    "relative inline-flex h-6 w-11 items-center transition-all border-[1.5px]",
                                    isActive ? "bg-success/10 border-success" : "bg-muted/10 border-border"
                                )}
                            >
                                <span className={cn(
                                    "inline-block h-3 w-3 transform transition-all duration-300",
                                    isActive ? "translate-x-6 bg-success" : "translate-x-1 bg-muted-foreground"
                                )} />
                            </button>
                        </div>
                    </div>

                    {submitError && (
                        <p className="text-xs font-semibold text-destructive text-center bg-destructive/10 p-3.5 border border-destructive/20">{submitError}</p>
                    )}
                </div>
            )}

        </ModalContent>

        <ModalFooter className="justify-between">
            {currentStep > 1 ? (
                <button 
                    type="button" 
                    onClick={() => setCurrentStep(prev => prev - 1)} 
                    className="h-10 px-4 border border-border/60 bg-background text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors flex items-center"
                >
                    <ChevronLeft className="mr-1.5 h-4 w-4" /> Back
                </button>
            ) : (
                <button 
                    type="button" 
                    onClick={onClose} 
                    className="h-10 px-4 border border-border/60 bg-background text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
                >
                    Cancel
                </button>
            )}

            {currentStep < 4 ? (
                <button
                    type="button"
                    onClick={() => {
                        if (currentStep === 1 && !isStep1Valid) {
                          toastService.error(
                            'Missing field',
                            workflowDiscipline === 'compliance' && !hasSelectedAssignedComplianceFramework
                              ? 'Assign a compliance framework to this scope before using compliance automations.'
                              : 'Automation name and intelligence category are required.',
                          );
                          return;
                        }
                        if (currentStep === 2 && !isStep2Valid) {
                          toastService.error('Missing field', 'Strategic mission goal cannot be empty.');
                          return;
                        }
                        setCurrentStep(prev => prev + 1);
                    }}
                    disabled={
                        (currentStep === 1 && !isStep1Valid) ||
                        (currentStep === 2 && !isStep2Valid)
                    }
                    className="h-10 px-5 bg-primary text-primary-foreground hover:bg-primary/95 text-xs font-semibold transition-colors disabled:opacity-50"
                >
                    Next phase
                </button>
            ) : (
                <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isPending}
                    className="h-10 px-5 bg-primary text-primary-foreground hover:bg-primary/95 text-xs font-semibold transition-colors"
                >
                    {isPending ? <><span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden /> Saving</> : isEditing ? 'Update automation' : 'Initialize automation'}
                </button>
            )}
        </ModalFooter>
    </Modal>
  );
}
