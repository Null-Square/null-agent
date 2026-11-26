import type { DeployRunnerResponse } from '@/modules/security-ops/api';
import { useDeployRunnerMutation, useRunnerDetailQuery } from '@/modules/security-ops/api';
import { cn, Modal, ModalContent } from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { toastService } from '@shared/services/toastService';
import { AlertTriangle, ArrowRight, Check, Copy, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface DeployRunnerModalProps {
  open: boolean;
  onClose: () => void;
}

export default function DeployRunnerModal({ open, onClose }: DeployRunnerModalProps) {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const [currentStep, setCurrentStep] = useState(1);
  const [name, setName] = useState('');
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [result, setResult] = useState<DeployRunnerResponse | null>(null);

  const deployRunner = useDeployRunnerMutation();

  const runnerId = result?.runner.id;
  const runnerQuery = useRunnerDetailQuery(runnerId ?? '', { enabled: !!runnerId && currentStep === 2 });
  const currentStatus = runnerQuery.data?.status ?? result?.runner.status;
  const healthState = runnerQuery.data?.metadata?.healthState ?? result?.runner.metadata?.healthState ?? 'awaiting_connect';
  const healthMessage = runnerQuery.data?.metadata?.healthMessage ?? result?.runner.metadata?.healthMessage;
  const isOnline = currentStatus === 'online';
  const pendingConnectionTitle =
    healthState === 'upgrade_required' ? 'Upgrade required' : 'Awaiting runner connection...';
  const pendingConnectionDescription =
    healthState === 'upgrade_required'
      ? healthMessage ?? 'Runner must be upgraded before it can complete the handshake.'
      : healthMessage ?? 'Follow the instructions below to spin up the node. This overlay synchronizes automatically upon successful handshake.';

  useEffect(() => {
    if (!runnerId || isOnline || currentStep !== 2) return;
    const interval = setInterval(() => { void runnerQuery.refetch(); }, 2000);
    return () => clearInterval(interval);
  }, [runnerId, isOnline, runnerQuery, currentStep]);

  useEffect(() => {
    if (!open) {
        setCurrentStep(1);
        setName('');
        setResult(null);
        setShowToken(false);
    }
  }, [open]);

  if (!open) return null;

  const resetAndClose = () => {
    onClose();
  };

  const handleCopyToken = async () => {
    if (!result?.token) return;
    await navigator.clipboard.writeText(result.token);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 1500);
    toastService.success('Token Stored', 'Encrypted connection key copied.');
  };

  const handleCopyCommand = async () => {
    if (!result?.installCommand) return;
    await navigator.clipboard.writeText(result.installCommand);
    setCopiedCommand(true);
    setTimeout(() => setCopiedCommand(false), 1500);
    toastService.success('Command Stored', 'Deployment logic copied.');
  };

  const handleSubmit = () => {
    deployRunner.mutate(
      { name: name.trim(), type: 'private', platform: 'docker' },
      {
        onSuccess: (data) => {
          setResult(data);
          setCurrentStep(2);
          toastService.success('Node Deployed', 'Runner registry updated.');
        },
        onError: (error) => {
          toastService.error('Deployment Refused', error instanceof Error ? error.message : 'Fleet allocation error.');
        },
      },
    );
  };

  const handleGoToDetails = () => {
    if (runnerId) {
      navigate(paths.runnerDetail(runnerId));
      onClose();
    }
  };

  return (
    <Modal isOpen onClose={resetAndClose} title="Deploy runner node" size="md">
      <ModalContent className="space-y-6 p-6">
        {/* Two steps, drawn as the lattice draws progress: filled cells, not a
            rounded track. */}
        <div className="flex items-center gap-2">
          <div className={cn('h-1 flex-1 transition-colors', currentStep >= 1 ? 'bg-primary' : 'bg-border')} />
          <div className={cn('h-1 flex-1 transition-colors', currentStep >= 2 ? 'bg-primary' : 'bg-border')} />
        </div>
        <div>
            {/* Step 1: Configuration */}
            {currentStep === 1 && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
                    <div className="space-y-1">
                        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Fleet allocation</h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            Provide a handle to identify this execution endpoint in the distributed compute fleet.
                        </p>
                    </div>
                    
                    <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Runner name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. AWS_SEC_GATEWAY_01"
                            className="w-full bg-background border border-border/75 h-11 font-sans text-xs px-4 text-foreground uppercase focus:border-primary outline-none placeholder:text-muted-foreground/40"
                            autoFocus
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && name.trim()) handleSubmit();
                             }}
                        />
                    </div>
                    
                    <div className="flex justify-end pt-2">
                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={!name.trim() || deployRunner.isPending}
                            className="inline-flex h-10 items-center justify-center bg-primary px-5 text-xs font-semibold text-primary-foreground hover:bg-primary/95 transition-colors disabled:opacity-50"
                        >
                            {deployRunner.isPending ? <><span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden /> <span className="ml-1.5">Deploying</span></> : 'Initialize'}
                            {!deployRunner.isPending && <ArrowRight className="ml-1.5 h-3.5 w-3.5" />}
                        </button>
                    </div>
                </div>
            )}

            {/* Step 2: Protocol Exchange */}
            {currentStep === 2 && result && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
                    
                    {/* Live connection tracker animation */}
                    {!isOnline ? (
                      <div className="flex flex-col items-center justify-center p-5 border border-dashed border-border bg-primary/5 text-center space-y-2">
                        {healthState === 'upgrade_required' ? (
                          <AlertTriangle className="h-5 w-5 text-warning" />
                        ) : (
                          <span className="ns-live-mark h-[9px] w-[9px] flex-none bg-primary" aria-hidden />
                        )}
                        <span className="text-xs font-semibold text-foreground">{pendingConnectionTitle}</span>
                        <p className="text-[11px] text-muted-foreground max-w-sm leading-relaxed">
                          {pendingConnectionDescription}
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center p-5 border border-success/20 bg-success/5 text-center space-y-2 animate-in zoom-in-95 duration-500">
                        <div className="p-2 bg-success/10 border border-success/20">
                          <ShieldCheck className="h-6 w-6 text-success" />
                        </div>
                        <span className="text-sm font-semibold text-success">Runner connected successfully!</span>
                        <p className="text-xs text-muted-foreground max-w-sm leading-relaxed">
                          Handshake completed. The array is ready for secure security operations.
                        </p>
                      </div>
                    )}

                    <div className="space-y-5">
                        {/* Primary Bootstrap Command UX */}
                        <div className="space-y-2">
                            <label className="text-[10px] uppercase font-bold text-foreground tracking-wider block">
                              1. Paste and run this command in your PowerShell or terminal
                            </label>
                            <div className="flex gap-2">
                                <code className="flex-1 bg-black text-white/90 border border-border/70 font-mono text-[11px] p-3.5 overflow-x-auto whitespace-pre custom-scrollbar select-all leading-relaxed">
                                    {result.installCommand}
                                </code>
                                <button
                                    type="button"
                                    onClick={handleCopyCommand}
                                    className="h-11 px-4 border border-border bg-background hover:bg-muted/10 transition-colors shrink-0 flex items-center justify-center"
                                    title="Copy Command"
                                >
                                    {copiedCommand ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                                </button>
                            </div>
                            <span className="text-[10px] text-muted-foreground leading-normal block">
                              Prerequisite: Docker must be running on your local machine before starting the node.
                            </span>
                        </div>

                        {/* Redacted Access Token */}
                        <div className="space-y-2 pt-2 border-t border-border/40">
                            <label className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider block">
                              Runner connection token (Secure credentials)
                            </label>
                            <div className="flex gap-2">
                                <code className="flex-1 bg-muted/5 border border-border font-mono text-xs p-3 overflow-hidden truncate select-none text-muted-foreground/80 flex items-center">
                                    {showToken ? result.token : '••••••••••••••••••••••••••••••••••••••••'}
                                </code>
                                <button
                                    type="button"
                                    onClick={() => setShowToken(!showToken)}
                                    className="h-10 px-3.5 border border-border bg-background text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors shrink-0 flex items-center gap-1.5"
                                >
                                    {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                    <span>{showToken ? 'Hide' : 'Show'}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={handleCopyToken}
                                    className="h-10 px-3.5 border border-border bg-background text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors shrink-0 flex items-center justify-center"
                                    title="Copy Token"
                                >
                                    {copiedToken ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="border-t border-border pt-5 flex items-center justify-between">
                        <button 
                            type="button" 
                            onClick={resetAndClose} 
                            className="h-10 px-4 border border-border bg-background hover:bg-muted/10 text-xs font-semibold text-muted-foreground transition-colors"
                        >
                            Dismiss
                        </button>
                        <button
                            type="button"
                            onClick={handleGoToDetails}
                            className="h-10 px-5 bg-primary text-primary-foreground hover:bg-primary/95 text-xs font-semibold transition-colors"
                        >
                            Open command center
                        </button>
                    </div>
                </div>
            )}
        </div>
      </ModalContent>
    </Modal>
  );
}
