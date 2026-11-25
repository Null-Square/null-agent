import { useParams } from "react-router-dom";
import { ListPageShell, SectionPanel } from "@null-ai/design-tokens/ui";
import { useLocal, projectPath } from "../local";
import RisksPage from "../modules/risks/ui/RisksPage";
import FindingDetailPage from "../modules/findings/ui/FindingDetailPage";

export function Risks() {
  const { id } = useParams();
  return id ? <FindingDetailPage key={id} findingId={id} /> : <RisksPage />;
}
export function Reports() {
  const { id, project } = useLocal();
  return (
    <ListPageShell title="Reports" subtitle={project?.name}>
      <SectionPanel title="Assessment results">
        <div className="flex flex-wrap gap-5">
          {["md", "sarif"].map((ext) => (
            <a
              className="underline"
              key={ext}
              href={"/api" + projectPath(id) + "/report." + ext}
              download
            >
              {ext === "md" ? "Download Markdown report" : "Download SARIF"}
            </a>
          ))}
        </div>
      </SectionPanel>
    </ListPageShell>
  );
}
