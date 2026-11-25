import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { FileText, Upload, X } from "lucide-react";
import {
  Button,
  NativeSelect,
  Modal,
  ModalContent,
  ModalFooter,
} from "@null-ai/design-tokens/ui";
import { useLocal, projectAPI, projectPath } from "../../../local";

export function EvidenceUploadModal({
  isOpen,
  onClose,
  controlId,
  framework,
  controls = [],
}: {
  isOpen: boolean;
  onClose: () => void;
  controlId?: string;
  framework?: string;
  controls?: { id: string; title: string }[];
}) {
  const { id: scopeId, refresh } = useLocal();
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [linkedControl, setLinkedControl] = useState("");
  const controlSelectId = useId();
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setFiles([]);
    setLinkedControl("");
    setError("");
    setDragOver(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const list = Array.from(incoming);
    setFiles((prev) => [...prev, ...list]);
  };

  const removeFile = (index: number) =>
    setFiles((prev) => prev.filter((_, i) => i !== index));

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    addFiles(event.dataTransfer.files);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!files.length || !scopeId) return;
    setUploading(true);
    setError("");
    const failed: File[] = [];
    const errors: string[] = [];
    try {
      for (const file of files) {
        try {
          if (file.size > 1024 * 1024)
            throw new Error("Choose a file up to 1 MiB.");
          const control = controlId || linkedControl;
          if (control && framework) {
            const query = new URLSearchParams({ controlId: control, framework });
            const response = await fetch("/api" + projectPath(scopeId) + "/artifacts/file?" + query, {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream", "X-Evidence-Name": encodeURIComponent(file.name) },
              body: file,
            });
            const body = await response.json().catch(() => null);
            if (!response.ok || !body) throw new Error(body?.error ?? "Could not save the attachment.");
          } else {
            await projectAPI(scopeId, "/artifacts", "POST", {
              name: file.name,
              content: await file.text(),
              framework,
            });
          }
        } catch (e) {
          failed.push(file);
          errors.push(
            file.name +
              ": " +
              (e instanceof Error ? e.message : "Upload failed."),
          );
        }
      }
      await refresh();
      setFiles(failed);
      if (failed.length) setError(errors.join("\n"));
      else onClose();
    } finally {
      setUploading(false);
    }
  };
  const canSubmit = Boolean(scopeId && files.length > 0 && !uploading);

  return (
    <Modal
      isOpen
      onClose={() => {
        if (!uploading) onClose();
      }}
      title="Upload evidence"
      size="md"
    >
      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalContent className="space-y-4 p-6">
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
            {controlId ? "Control " + controlId : "Local evidence library"}
          </p>
          {!controlId && controls.length > 0 && (
            <div className="space-y-2 text-sm">
              <label htmlFor={controlSelectId}>Link to control</label>
              <NativeSelect id={controlSelectId} value={linkedControl} onChange={event => setLinkedControl(event.target.value)} disabled={uploading}>
                <option value="">Import into the evidence library</option>
                {controls.map(control => <option key={control.id} value={control.id}>{control.id} · {control.title}</option>)}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-4">
            <div
              role="button"
              tabIndex={0}
              aria-label="Choose evidence files"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`flex cursor-pointer flex-col items-center justify-center border border-dashed p-8 text-center transition-colors ${
                dragOver
                  ? "border-primary bg-primary/10"
                  : "border-border/70 bg-surface-1/30 hover:bg-surface-1/50"
              }`}
            >
              <input
                type="file"
                name="file"
                aria-label="Evidence file"
                multiple
                disabled={uploading}
                ref={fileInputRef}
                onChange={(event) => addFiles(event.target.files)}
                className="hidden"
              />
              <Upload className="mb-2 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium text-foreground">
                Drag files here, or click to browse
              </p>
              <p className="text-xs text-muted-foreground">
                Scanner JSON or JSONL, UTF-8 notes, source files, or unified
                diffs.
              </p>
            </div>

            {files.length > 0 ? (
              <div className="space-y-2">
                <p className="ml-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {files.length} file{files.length === 1 ? "" : "s"} ready
                </p>
                <div className="max-h-56 space-y-1.5 overflow-y-auto">
                  {files.map((file, index) => (
                    <div
                      key={`${file.name}-${index}`}
                      className="flex items-center gap-3 border border-border/70 bg-surface-1/30 px-3 py-2"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">
                          {file.name}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {(file.size / 1024).toFixed(1)} KB
                        </p>
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
            <p className="flex-1 text-sm text-muted-foreground">
              Select a scope to enable upload.
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button type="submit" loading={uploading} disabled={!canSubmit}>
            {uploading
              ? "Uploading"
              : files.length > 1
                ? `Upload ${files.length} files`
                : "Upload"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
