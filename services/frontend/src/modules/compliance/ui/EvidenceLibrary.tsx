import { EvidenceUploadModal } from "./EvidenceUploadModal";
import { useId, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  Button,
  QueryBar,
  RecordTable,
  ListEmptyState,
  ListMetrics,
  Modal,
  ModalContent,
  ModalFooter,
  NativeSelect,
} from "@null-ai/design-tokens/ui";
import {
  useLocal,
  projectAPI,
  evidenceURL,
  useReadiness,
  type Artifact,
} from "../../../local";
export function EvidenceLibrary({
  controlId,
  framework,
  artifactIds,
}: {
  controlId?: string;
  framework?: string;
  artifactIds?: string[];
}) {
  const { id, project, refresh } = useLocal();
  const readiness = useReadiness().data;
  const frameworkKey = framework ?? project?.framework;
  const controls = readiness?.frameworks.find(entry => entry.key === frameworkKey)?.controls ?? [];
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Artifact | null>(null);
  const [removing, setRemoving] = useState<Artifact | null>(null);
  const [destination, setDestination] = useState("");
  const controlSelectId = useId();
  const items = (project?.artifacts || []).filter(
    (item) => !artifactIds || artifactIds.includes(item.id),
  );
  const filteredItems = items.filter((i) =>
    i.name.toLowerCase().includes(search.toLowerCase()),
  );
  const file = items.find((i) => i.id === selected);
  async function remove(a: Artifact) {
    setBusy(true);
    setError("");
    try {
      await projectAPI(id, "/artifacts/" + a.id, "DELETE");
      await refresh();
      setRemoving(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function relink() {
    if (!editing || !destination || !frameworkKey || busy) return;
    setBusy(true);
    setError("");
    try {
      await projectAPI(id, "/artifacts/" + encodeURIComponent(editing.id) + "/control", "PATCH", {
        framework: frameworkKey,
        controlId: destination,
      });
      await refresh();
      setEditing(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The evidence could not be linked.");
    } finally {
      setBusy(false);
    }
  }
  function edit(item: Artifact) {
    setError("");
    setDestination(item.controlFramework === frameworkKey ? item.controlId ?? "" : "");
    setEditing(item);
  }
  function confirmRemoval(item: Artifact) {
    setError("");
    setRemoving(item);
  }
  return (
    <section>
      <ListMetrics
        items={[
          { label: "Evidence files", value: items.length },
          {
            label: "Findings",
            value: items.reduce((count, item) => count + item.findingCount, 0),
          },
        ]}
      />
      <div className="my-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Add text notes, saved analyzer results, a source file or a unified
          diff.
        </p>
        <Button disabled={busy} onClick={() => setOpen(true)}>
          {busy ? "Working…" : "Upload evidence"}
        </Button>
      </div>
      <EvidenceUploadModal
        isOpen={open}
        onClose={() => setOpen(false)}
        controlId={controlId}
        framework={frameworkKey}
        controls={controls}
      />
      {error && !editing && !removing && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <QueryBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search evidence"
        aria-label="Filter evidence"
      />
      <div className="mt-5">
        {!filteredItems.length ? (
          <ListEmptyState
            variant="filtered"
            icon="evidence"
            title={
              search ? "No evidence matches this query" : "No evidence uploaded"
            }
            description="Choose a file from your machine to add it to this scope."
          />
        ) : (
          <RecordTable
            rows={filteredItems}
            getRowKey={(i) => i.id}
            titleHeader="Title / source"
            title={(i) => i.name}
            subtitle={(i) => (
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]">
                {i.kind === "compliance_attachment" ? "Evidence attachment" : i.kind || "Local file"} · {i.sizeBytes} bytes
              </span>
            )}
            onRowClick={(i) => setSelected(i.id)}
            rowActionLabel={(i) => "View " + i.name}
            columns={[
              {
                key: "control",
                header: "Linked control",
                width: "120px",
                render: item => item.controlId ?? "—",
              },
              {
                key: "findings",
                header: "Findings",
                width: "100px",
                render: (i) => i.findingCount,
                showOnMobile: true,
              },
              {
                key: "uploaded",
                header: "Uploaded",
                width: "150px",
                render: (i) => new Date(i.createdAt).toLocaleDateString(),
              },
            ]}
            actions={(item) => (
              <div className="flex items-center gap-2">
                <a className="underline text-xs" href={evidenceURL(id, item.id)} download>Download</a>
                {item.canRelink && controls.length > 0 && (
                  <Button variant="ghost" size="sm" aria-label={"Edit evidence " + item.name} onClick={() => edit(item)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                {item.canRelink && (
                  <Button variant="ghost" size="sm" aria-label={"Delete evidence " + item.name} onClick={() => confirmRemoval(item)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            )}
          />
        )}
      </div>
      {file && (
        <div className="my-6 grid gap-3 border-t border-border pt-5">
          <h3 className="font-semibold">{file.name}</h3>
          {file.sourcePreview && (
            <pre className="overflow-auto whitespace-pre-wrap">
              {file.sourcePreview.sourceExcerpt}
            </pre>
          )}
          {file.excerpt && (
            <p className="whitespace-pre-wrap">{file.excerpt}</p>
          )}
          <div className="flex gap-3">
            <a href={evidenceURL(id, file.id)} download>
              Download original
            </a>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => confirmRemoval(file)}
            >
              Remove evidence
            </Button>
          </div>
        </div>
      )}
      <Modal isOpen={editing !== null} onClose={() => !busy && setEditing(null)} title="Edit evidence" size="md">
        <ModalContent className="space-y-4">
          <p className="text-sm font-medium">{editing?.name}</p>
          <div className="space-y-2 text-sm">
            <label htmlFor={controlSelectId}>Linked control</label>
            <NativeSelect id={controlSelectId} value={destination} onChange={event => setDestination(event.target.value)} disabled={busy}>
              <option value="">Choose a control</option>
              {controls.map(control => <option key={control.id} value={control.id}>{control.id} · {control.title}</option>)}
            </NativeSelect>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </ModalContent>
        <ModalFooter>
          <Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void relink()} disabled={!destination} loading={busy}>Save changes</Button>
        </ModalFooter>
      </Modal>
      <Modal isOpen={removing !== null} onClose={() => !busy && setRemoving(null)} title="Remove evidence" size="sm">
        <ModalContent>
          <p className="text-sm text-muted-foreground">
            Remove the workspace copy of <strong className="text-foreground">{removing?.name}</strong> and its links.
          </p>
          {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        </ModalContent>
        <ModalFooter>
          <Button variant="outline" onClick={() => setRemoving(null)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={() => removing && void remove(removing)} loading={busy}>Remove</Button>
        </ModalFooter>
      </Modal>
    </section>
  );
}
