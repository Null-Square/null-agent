import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ListMetrics,
  QueryBar,
  StatusPill,
  RecordTable,
  ListEmptyState,
  Button,
  Modal,
  ModalContent,
  ModalFooter,
  Input,
  Textarea,
} from "@null-ai/design-tokens/ui";
import SettingsLayout from "../../settings/ui/SettingsLayout";
import { useLocal, request, type Project } from "../../../local";
export function Scopes() {
  const ctx = useLocal();
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const scopes = ctx.scopes.filter((scope) =>
    [scope.name, scope.scope].some((text) =>
      text.toLowerCase().includes(query),
    ),
  );
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [scope, setScope] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function create() {
    setSaving(true);
    setError("");
    try {
      const p = await request<Project>("/projects", "POST", {
        name: name.trim(),
        scope,
        framework: "nist_csf",
      });
      await ctx.refresh();
      ctx.select(p.id);
      setOpen(false);
      nav("/scopes/" + encodeURIComponent(p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create scope.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsLayout
      title="Scopes"
      description="Manage the assessment scope, evidence, and compliance framework."
      backPath={null}
      actions={
        <Button
          onClick={() => {
            setName("");
            setScope("");
            setError("");
            setOpen(true);
          }}
        >
          New scope
        </Button>
      }
    >
      <ListMetrics
        className="mb-8"
        label="Scope coverage"
        items={[
          { label: "Scopes", value: ctx.scopes.length },
          {
            label: "With evidence",
            value: ctx.scopes.filter((scope) => scope.artifactCount > 0).length,
          },
          {
            label: "Awaiting evidence",
            value: ctx.scopes.filter((scope) => scope.artifactCount === 0)
              .length,
          },
        ]}
      />
      <QueryBar
        className="mb-8"
        aria-label="Filter scopes"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search scopes"
      />
      {scopes.length ? (
        <RecordTable
          rows={scopes}
          getRowKey={(scope) => scope.id}
          titleHeader="Scope"
          title={(scope) => scope.name}
          subtitle={(scope) => scope.scope}
          rowActionLabel={(scope) => `Open scope: ${scope.name}`}
          onRowClick={(scope) => nav("/scopes/" + encodeURIComponent(scope.id))}
          columns={[
            {
              key: "state",
              header: "Evidence",
              showOnMobile: true,
              render: (scope) => (
                <StatusPill tone={scope.artifactCount ? "success" : "neutral"}>
                  {scope.artifactCount
                    ? scope.artifactCount + " files"
                    : "Awaiting evidence"}
                </StatusPill>
              ),
            },
            {
              key: "risks",
              header: "Risks",
              mono: true,
              render: (scope) => scope.findingCount,
            },
            {
              key: "updated",
              header: "Updated",
              mono: true,
              align: "end",
              render: (scope) => new Date(scope.updatedAt).toLocaleDateString(),
            },
          ]}
        />
      ) : query ? (
        <ListEmptyState
          variant="filtered"
          icon="search"
          title="No scopes match this query"
          onClear={() => setSearch("")}
        />
      ) : (
        <ListEmptyState
          icon="scope"
          title="No scopes yet"
          description="Create a scope to record the system or process your assessment covers."
        />
      )}
      <Modal
        isOpen={open}
        onClose={() => {
          if (!saving) setOpen(false);
        }}
        title="Create new scope"
      >
        <ModalContent>
          <form
            id="scope-form"
            className="local-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              Scope name
              <Input
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Description
              <Textarea
                maxLength={2000}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="notice">
                {error}
              </p>
            )}
          </form>
        </ModalContent>
        <ModalFooter>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            form="scope-form"
            type="submit"
            disabled={!name.trim() || saving}
          >
            Create scope
          </Button>
        </ModalFooter>
      </Modal>
    </SettingsLayout>
  );
}
