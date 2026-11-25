import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AgentWorkbenchShell,
  AgentWorkbenchPhaseRail,
  Button,
  ListPageShell,
  SectionPanel,
  StatusPill,
} from "@null-ai/design-tokens/ui";
import { useLocal, projectAPI, usePreference } from "../local";
import { EvidenceLibrary } from "../modules/compliance/ui/EvidenceLibrary";

const ReviewText = lazy(() => import("../modules/compliance/ui/ReviewText"));

function SavedText({ text }: { text: string }) {
  return (
    <Suspense fallback={<p className="my-3 whitespace-pre-wrap">{text}</p>}>
      <ReviewText text={text} />
    </Suspense>
  );
}

export function Review() {
  const { id, project, refresh } = useLocal();
  const pref = usePreference().data ?? { provider: "ollama", model: null };
  const cloud = pref.provider !== "ollama";
  const providerName = pref.provider === "anthropic" ? "Claude" : pref.provider === "chatgpt" ? "ChatGPT" : "OpenAI";
  const [phase, setPhase] = useState("review"),
    [workflow, setWorkflow] = useState("code-review"),
    [busy, setBusy] = useState(false),
    [omitted, setOmitted] = useState<string[]>([]),
    [confirmedInputs, setConfirmedInputs] = useState(""),
    [error, setError] = useState("");
  const findingFiles = new Set(
    project?.findings
      .filter(
        (f) =>
          workflow === "compliance" || f.location || f.source === "semgrep",
      )
      .flatMap((f) => f.evidence.map((e) => e.id)),
  );
  const compatible =
    project?.artifacts.filter(
      (a) =>
        findingFiles.has(a.id) ||
        (workflow === "compliance"
          ? !!a.excerpt
          : a.kind === "source" || a.kind === "patch"),
    ) ?? [];
  const selected = compatible
    .filter((a) => !omitted.includes(a.id))
    .map((a) => a.id);
  const inputs = JSON.stringify([
    id,
    project?.revision,
    pref.provider,
    pref.model,
    workflow,
    selected,
  ]);
  const consent = confirmedInputs === inputs;
  useEffect(() => setConfirmedInputs(""), [inputs]);
  if (!project) return null;
  async function run() {
    setError("");
    setBusy(true);
    setConfirmedInputs("");
    try {
      await projectAPI(id, "/review", "POST", {
        ...pref,
        workflow,
        artifactIds: selected,
        sendEvidence: cloud && consent,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ListPageShell
      title="Assessment workbench"
      subtitle={project.name}
      backLink={
        <Link
          className="text-sm underline"
          to={"/runs/" + encodeURIComponent(project.id)}
        >
          Back to assessment
        </Link>
      }
    >
      <div className="min-h-[540px]">
        <AgentWorkbenchShell
          modeLabel="Review"
          statusTone={busy ? "active" : "idle"}
          statusLabel={busy ? "Review running" : "Ready"}
          taskTitle="Scope"
          sessionId={id}
          counterLabel={project.findings.length === 1 ? "finding" : "findings"}
          counterValue={project.findings.length}
          phaseRail={
            <AgentWorkbenchPhaseRail
              phases={["evidence", "review", "history"].map((s) => ({
                id: s,
                label: s.charAt(0).toUpperCase() + s.slice(1),
                status: "pending",
                selected: s === phase,
              }))}
              onSelect={setPhase}
            />
          }
          transcript={
            <div className="p-5">
              {error && (
                <p role="alert" className="notice">
                  {error}
                </p>
              )}
              {phase === "evidence" ? (
                <EvidenceLibrary />
              ) : phase === "history" ? (
                <section>
                  <h2 className="font-semibold">Saved reviews</h2>
                  {[...project.reviews].reverse().map((r) => (
                    <details
                      key={r.id}
                      className="mt-3 border-t border-border py-3"
                    >
                      <summary>
                        {r.model} · {r.workflow} ·{" "}
                        {new Date(r.createdAt).toLocaleString()}
                      </summary>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Evidence used:{" "}
                        {r.artifactIds
                          .map(
                            (id) =>
                              project.artifacts.find((a) => a.id === id)
                                ?.name ?? `Removed file (${id})`,
                          )
                          .join(", ")}
                      </p>
                      <SavedText text={r.text} />
                    </details>
                  ))}
                  {!project.reviews.length && <p>No reviews saved.</p>}
                </section>
              ) : (
                <SectionPanel
                  title="Model-assisted review"
                  description="Use the selected model to review the scope and its imported evidence."
                >
                  <form
                    className="local-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run();
                    }}
                  >
                    <label>
                      Review type
                      <select
                        value={workflow}
                        disabled={busy}
                        onChange={(e) => {
                          setOmitted([]);
                          setError("");
                          setWorkflow(e.target.value);
                        }}
                      >
                        <option value="code-review">Code review</option>
                        <option value="compliance">Compliance review</option>
                      </select>
                    </label>
                    <fieldset disabled={busy} className="grid gap-2">
                      <legend className="mb-2 font-medium">
                        Evidence to review
                      </legend>
                      {compatible.map((a) => (
                        <label key={a.id} className="review-file">
                          <input
                            type="checkbox"
                            checked={!omitted.includes(a.id)}
                            onChange={(e) =>
                              setOmitted(
                                e.target.checked
                                  ? omitted.filter((id) => id !== a.id)
                                  : [...omitted, a.id],
                              )
                            }
                          />
                          <span>{a.name}</span>
                        </label>
                      ))}
                      {!selected.length && (
                        <p
                          role="status"
                          className="text-sm text-muted-foreground"
                        >
                          {compatible.length
                            ? "Select at least one evidence file."
                            : workflow === "code-review"
                              ? "Add a source file, patch, or static analysis finding in the Evidence phase."
                              : "Add a note or analyzer findings in the Evidence phase."}
                        </p>
                      )}
                    </fieldset>
                    <p>
                      Model: {pref.model || "None selected"} ·{" "}
                      <Link className="underline" to="/models">
                        Model settings
                      </Link>
                    </p>
                    {cloud && (
                      <label>
                        <span>
                          <input
                            type="checkbox"
                            checked={consent}
                            disabled={busy || !selected.length}
                            onChange={(e) =>
                              setConfirmedInputs(e.target.checked ? inputs : "")
                            }
                          />{" "}
                          Send this scope and the selected evidence to {providerName}
                          for this review.
                        </span>
                      </label>
                    )}
                    <div className="flex flex-wrap gap-3">
                      <Button
                        disabled={
                          !pref.model ||
                          !selected.length ||
                          busy ||
                          (cloud && !consent)
                        }
                        type="submit"
                      >
                        {busy ? "Reviewing…" : "Run review"}
                      </Button>
                      {busy && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={async () => {
                            try {
                              await projectAPI(
                                id,
                                "/review/cancel",
                                "POST",
                                {},
                              );
                            } catch (e) {
                              setError(String(e));
                            }
                          }}
                        >
                          Cancel review
                        </Button>
                      )}
                    </div>
                  </form>
                  {project.review && (
                    <article className="mt-7">
                      <h3 className="font-semibold">Latest review</h3>
                      <SavedText text={project.review.text} />
                    </article>
                  )}
                </SectionPanel>
              )}
            </div>
          }
          opsConsole={
            <div className="p-5">
              <h3 className="font-semibold">{project.name}</h3>
              <p className="mt-2">{project.scope || "No scope description."}</p>
            </div>
          }
          plan={
            <div className="p-5">
              <StatusPill tone="neutral">
                {project.artifacts.length} evidence{" "}
                {project.artifacts.length === 1 ? "file" : "files"}
              </StatusPill>
            </div>
          }
        />
      </div>
    </ListPageShell>
  );
}
