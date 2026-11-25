import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Button,
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DisclosurePanel,
  Input,
  ListEmptyState,
  ListMetrics,
  ListSkeleton,
  StatusPill,
  Textarea,
} from "@null-ai/design-tokens/ui";
import { projectAPI, useLocal, type Project } from "../../../local";
import { COMPLIANCE_FRAMEWORK_OPTIONS } from "../../security-ops/complianceFrameworks";
import { recordedAssets } from "../../assets/recordedAssets";
import { useLocalAccount } from "../../account/localAccount";
import { LocalScopeFolderPanel } from "../../account/LocalScopeFolderPanel";

function ScopeDetail({ scope }: { scope: Project }) {
  const { id, select, refresh } = useLocal();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const account = useLocalAccount().data;
  const owner = account?.stage === "ready" ? account.owner : null;
  const website = owner?.setupScopeId === scope.id ? owner?.website : null;
  const [name, setName] = useState(scope.name);
  const [description, setDescription] = useState(scope.scope);
  const [framework, setFramework] = useState(scope.framework);
  const save = useMutation({
    mutationFn: () =>
      projectAPI<Project>(scope.id, "", "PATCH", {
        name,
        scope: description,
        framework,
      }),
    onSuccess: async (saved) => {
      setName(saved.name);
      setDescription(saved.scope);
      setFramework(saved.framework);
      cache.setQueryData(["scope", scope.id], saved);
      await refresh();
    },
  });
  const changed =
    name.trim() !== scope.name ||
    description.trim() !== scope.scope ||
    framework !== scope.framework;
  return (
    <DetailPageShell
      backLink={
        <DetailBackLink label="Scopes" onClick={() => navigate("/scopes")} />
      }
      displayId={scope.id.split("-")[0]}
    >
      <DetailHeader
        title={scope.name}
        subline={["Local workspace"]}
        badges={
          <StatusPill tone={id === scope.id ? "success" : "neutral"}>
            {id === scope.id ? "Active scope" : "Saved scope"}
          </StatusPill>
        }
      />
      <ListMetrics
        className="mt-8"
        label="Scope coverage"
        items={[
          { label: "Recorded assets", value: recordedAssets(scope).length },
          { label: "Evidence files", value: scope.artifactCount },
          { label: "Saved reviews", value: scope.reviewCount },
        ]}
      />
      <div className="mt-8 space-y-3">
        <DisclosurePanel title="Targets" description="Website recorded for this scope." defaultOpen>
          {website ? (
            <p className="truncate font-mono text-sm text-foreground">{website}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No website recorded for this scope.</p>
          )}
        </DisclosurePanel>
        <DisclosurePanel title="Local source folder" description="Select a folder from this computer." defaultOpen>
          <LocalScopeFolderPanel scopeId={scope.id} folder={owner?.scopeFolders[scope.id] ?? ""} />
        </DisclosurePanel>
      </div>
      <form
        className="mt-8 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <DisclosurePanel
          title="Scope details"
          description="Name the system or process this assessment covers."
          defaultOpen
        >
          <div className="local-form">
            <label>
              Scope name
              <Input
                value={name}
                maxLength={120}
                required
                disabled={save.isPending}
                onChange={(event) => {
                  setName(event.target.value);
                  save.reset();
                }}
              />
            </label>
            <label>
              Description
              <Textarea
                value={description}
                maxLength={2000}
                disabled={save.isPending}
                onChange={(event) => {
                  setDescription(event.target.value);
                  save.reset();
                }}
              />
            </label>
          </div>
        </DisclosurePanel>
        <DisclosurePanel
          title="Compliance"
          description="Framework shown for this scope."
        >
          <label className="local-form">
            Framework
            <select
              value={framework}
              disabled={save.isPending}
              onChange={(event) => {
                setFramework(event.target.value);
                save.reset();
              }}
            >
              {COMPLIANCE_FRAMEWORK_OPTIONS.map(({ key, label }) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </DisclosurePanel>
        <div className="flex flex-wrap items-center gap-3 pt-3">
          <Button
            type="submit"
            disabled={!changed || !name.trim() || save.isPending}
          >
            Save changes
          </Button>
          {id !== scope.id && (
            <Button
              type="button"
              variant="outline"
              onClick={() => select(scope.id)}
            >
              Use scope
            </Button>
          )}
          <Link
            className="underline"
            to={"/runs/" + encodeURIComponent(scope.id)}
          >
            Open assessment
          </Link>
        </div>
        {save.isSuccess && <p role="status">Scope saved.</p>}
        {save.isError && (
          <p role="alert" className="notice">
            {save.error.message}
          </p>
        )}
      </form>
    </DetailPageShell>
  );
}

export default function ScopeDetailPage() {
  const { id = "" } = useParams();
  const scope = useQuery({
    queryKey: ["scope", id],
    queryFn: () => projectAPI<Project>(id),
  });
  if (scope.isLoading)
    return <ListSkeleton label="Reading this scope" rows={3} />;
  return scope.data ? (
    <ScopeDetail key={id} scope={scope.data} />
  ) : (
    <DetailPageShell>
      <ListEmptyState
        icon="scope"
        title="Scope unavailable"
        description={scope.error?.message}
        action={
          <Link to="/scopes" className="underline">
            Back to Scopes
          </Link>
        }
      />
    </DetailPageShell>
  );
}
