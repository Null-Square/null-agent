import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import { toastService } from '@shared/services/toastService';

import { useCreateComplianceEvidenceMutation } from '@/modules/security-ops/api';
import type { ComplianceEvidenceItem, ComplianceMissingEvidenceItem } from '@/modules/security-ops/types';
import { Button, Modal, ModalContent, ModalFooter } from '@null-ai/design-tokens/ui';

interface EvidenceUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  scopeId: string | null;
  /** When fulfilling a specific agent request, restricts to a single file and links it on success. */
  targetItem?: ComplianceMissingEvidenceItem | null;
  onUploaded?: (evidence: ComplianceEvidenceItem) => void;
  /** Demo-only: render a single mock file as "ready" (no real picker/upload). */
  previewFile?: { name: string; sizeKb: number } | null;
}

export function EvidenceUploadModal({ isOpen, onClose, scopeId, targetItem, onUploaded, previewFile }: EvidenceUploadModalProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mutation = useCreateComplianceEvidenceMutation();

  // Fulfilling a specific agent request -> exactly one file, linked back to the request.
  const single = Boolean(targetItem);

  useEffect(() => {
    if (!isOpen) return;
    setFiles([]);
    setDragOver(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const list = Array.from(incoming);
    setFiles((prev) => (single ? list.slice(0, 1) : [...prev, ...list]));
  };

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    addFiles(event.dataTransfer.files);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!scopeId) {
      toastService.error('Select a scope before uploading evidence.');
      return;
    }
    if (files.length === 0) {
      toastService.error('Attach at least one evidence file.');
      return;
    }

    setUploading(true);
    let lastEvidence: ComplianceEvidenceItem | null = null;
    let succeeded = 0;
    const failed: string[] = [];
    for (const file of files) {
      const formData = new FormData();
      formData.append('scopeId', scopeId);
      formData.append('title', file.name);
      formData.append('sourceType', 'user_upload');
      formData.append('file', file);
      try {
        const result = await mutation.mutateAsync(formData);
        lastEvidence = result.evidence;
        succeeded += 1;
      } catch {
        failed.push(file.name);
      }
    }
    setUploading(false);

    if (succeeded > 0) {
      if (targetItem && onUploaded && lastEvidence) onUploaded(lastEvidence);
      toastService.success(
        succeeded === 1
          ? 'Evidence uploaded. The agent will review, describe, and map it.'
          : `${succeeded} files uploaded. The agent will review, describe, and map them.`,
      );
    }
    if (failed.length > 0) {
      toastService.error(`Failed to upload: ${failed.join(', ')}`);
      return;
    }
    onClose();
  };

  const canSubmit = Boolean(scopeId && files.length > 0 && !uploading);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={targetItem ? 'Provide requested evidence' : 'Upload evidence'}
      size="md"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalContent className="space-y-4 p-6">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            {targetItem
              ? `Control ${targetItem.controlId}`
              : 'The agent describes, types, dates, and maps each file'}
          </p>
          <div className="space-y-4">
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`flex cursor-pointer flex-col items-center justify-center border border-dashed p-8 text-center transition-colors ${
                dragOver ? 'border-primary bg-primary/10' : 'border-border/70 bg-surface-1/30 hover:bg-surface-1/50'
              }`}
            >
              <input
                type="file"
                name="file"
                multiple={!single}
                ref={fileInputRef}
                onChange={(event) => addFiles(event.target.files)}
                className="hidden"
              />
              <Upload className="mb-2 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium text-foreground">
                {single ? 'Drag a file here, or click to browse' : 'Drag files here, or click to browse'}
              </p>
              <p className="text-xs text-muted-foreground">
                {single
                  ? 'PDF, PNG, JPG, DOCX, CSV, MD, or export files'
                  : 'Drop as many as you like — PDF, PNG, JPG, DOCX, CSV, MD, or export files'}
              </p>
            </div>

            {previewFile ? (
              <div className="space-y-2" data-tour="evidence-upload-preview">
                <p className="ml-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  1 file ready
                </p>
                <div className="flex items-center gap-3 border border-border/70 bg-surface-1/30 px-3 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{previewFile.name}</p>
                    <p className="text-[11px] text-muted-foreground">{previewFile.sizeKb.toFixed(1)} KB</p>
                  </div>
                </div>
              </div>
            ) : files.length > 0 ? (
              <div className="space-y-2">
                <p className="ml-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {files.length} file{files.length === 1 ? '' : 's'} ready
                </p>
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {files.map((file, index) => (
                    <div
                      key={`${file.name}-${index}`}
                      className="flex items-center gap-3 border border-border/70 bg-surface-1/30 px-3 py-2"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{file.name}</p>
                        <p className="text-[11px] text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeFile(index)}
                        disabled={uploading}
                        className="p-1 text-muted-foreground transition-colors hover:bg-surface-1/60 hover:text-foreground disabled:opacity-50"
                        aria-label={`Remove ${file.name}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </ModalContent>

        <ModalFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
          {!scopeId ? (
            <p className="flex-1 text-sm text-muted-foreground">Select a scope to enable upload.</p>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={uploading} disabled={!canSubmit}>
            {uploading
              ? 'Uploading'
              : files.length > 1
                ? `Upload ${files.length} files`
                : 'Upload'}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
