import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { findingDetails, importArtifact, invalid, isManageableComplianceEvidence } from "./evidence.mjs";
import {
  framework,
  snapshot,
  evidenceMappings,
  hasControl,
} from "./src/domains/security-ops/compliance/localReadiness.mjs";

function artifactDigest(artifact, content) {
  return createHash("sha256")
    .update(artifact.controlFramework ?? "")
    .update("\0")
    .update(artifact.controlId ?? "")
    .update("\0")
    .update(artifact.originalName ?? artifact.name)
    .update("\0")
    .update(content)
    .digest("hex");
}

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "workspace.sqlite");
    this.db = new DatabaseSync(file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 8) {
      this.db.close();
      throw new Error("A newer application is required to open this workspace.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL,framework TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, digest TEXT NOT NULL, metadata TEXT NOT NULL, content TEXT NOT NULL, UNIQUE(projectId,digest)); CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, entry TEXT NOT NULL);",
      );
      if (version === 1 || version === 2) {
        for (const row of this.db
          .prepare("SELECT id,revision,review FROM projects WHERE review IS NOT NULL")
          .all()) {
          const review = JSON.parse(row.review);
          review.id ??= randomUUID();
          review.evidenceRevision ??= row.revision;
          this.db
            .prepare("INSERT INTO reviews VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry")
            .run(review.id, row.id, JSON.stringify(review));
        }
        this.db.exec("ALTER TABLE projects DROP COLUMN review");
      }
      if (version === 4) this.db.exec("ALTER TABLE control_states RENAME TO old_control_states");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS control_states(projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, framework TEXT NOT NULL,controlId TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(projectId,framework,controlId)); CREATE TABLE IF NOT EXISTS model_preferences(singleton INTEGER PRIMARY KEY CHECK(singleton=1), provider TEXT NOT NULL,model TEXT);",
      );
      if (version === 4)
        this.db.exec(
          "INSERT INTO control_states SELECT projectId,'nist_csf',controlId,state,reason,updatedAt FROM old_control_states; DROP TABLE old_control_states",
        );
      if (version < 7) {
        this.db.exec(`
          CREATE TABLE finding_events (
            id INTEGER PRIMARY KEY,
            artifactId TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
            findingId TEXT NOT NULL,
            state TEXT NOT NULL,
            createdAt TEXT NOT NULL
          );
          CREATE INDEX finding_events_artifact ON finding_events(artifactId);
        `);
        this.restoreFindingDetails();
      }
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS local_profile (singleton INTEGER PRIMARY KEY CHECK(singleton=1), display_name TEXT NOT NULL); PRAGMA user_version=8",
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw err;
    }
  }
  restoreFindingDetails() {
    const ids = this.db
      .prepare("SELECT id FROM artifacts WHERE json_array_length(metadata,'$.findings') > 0")
      .all();
    const read = this.db.prepare("SELECT metadata,content FROM artifacts WHERE id=?");
    const update = this.db.prepare("UPDATE artifacts SET metadata=? WHERE id=?");
    for (const { id } of ids) {
      const row = read.get(id);
      const artifact = JSON.parse(row.metadata);
      let parsed;
      try {
        parsed = importArtifact(artifact.originalName ?? artifact.name, row.content);
      } catch (error) {
        // Preserve historical records if the current importer cannot interpret their originals.
        if (error.status === 400) continue;
        throw error;
      }
      let changed = false;
      for (const [index, finding] of artifact.findings.entries()) {
        const recovered = parsed.findings[index];
        if (!recovered || recovered.title !== finding.title || recovered.ruleId !== finding.ruleId)
          continue;
        const details = findingDetails(recovered);
        if (!Object.keys(details).length) continue;
        Object.assign(finding, details);
        changed = true;
      }
      if (changed) update.run(JSON.stringify(artifact), id);
    }
  }
  transact(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  get(id, viewFramework) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id);
    if (!project) throw invalid("Assessment not found.", 404);
    const artifacts = this.db
      .prepare("SELECT metadata FROM artifacts WHERE projectId=? ORDER BY rowid")
      .all(id)
      .map((row) => JSON.parse(row.metadata));
    const key = viewFramework ?? project.framework;
    const states = this.db
      .prepare(
        "SELECT controlId,state,reason,updatedAt FROM control_states WHERE projectId=? AND framework=?",
      )
      .all(id, key);
    const readiness = snapshot(artifacts, states, id, project.scope, key);
    const reviews = this.db
      .prepare("SELECT entry FROM reviews WHERE projectId=? ORDER BY rowid")
      .all(id)
      .map((row) => JSON.parse(row.entry));
    const histories = new Map();
    const events = this.db.prepare(`
      SELECT e.id,e.findingId,e.state,e.createdAt FROM finding_events e
      JOIN artifacts a ON a.id=e.artifactId WHERE a.projectId=? ORDER BY e.id
    `);
    for (const event of events.iterate(id)) {
      const history = histories.get(event.findingId) ?? [];
      history.push({
        id: String(event.id),
        type: "status_changed",
        fromStatus: history.at(-1)?.toStatus ?? "potential",
        toStatus: event.state,
        createdAt: event.createdAt,
      });
      histories.set(event.findingId, history);
    }
    const findings = artifacts.flatMap((artifact) =>
      artifact.findings.map((finding) => {
        const changes = histories.get(finding.id) ?? [];
        const imported = {
          id: finding.id + ":imported",
          type: "imported",
          toStatus: "potential",
          createdAt: artifact.createdAt,
        };
        return {
          ...finding,
          state: changes.at(-1)?.toStatus ?? "potential",
          history: [imported, ...changes],
        };
      }),
    );
    return {
      ...project,
      findingCount: findings.length,
      artifactCount: artifacts.length,
      reviewCount: reviews.length,
      reviews,
      review: reviews.findLast((review) => review.evidenceRevision === project.revision) ?? null,
      artifacts: artifacts.map(({ findings, originalName: _localName, ...a }) => ({
        ...a,
        originalName: a.name,
        findingCount: findings.length,
        canRelink: isManageableComplianceEvidence({ ...a, findings }),
      })),
      findings,
      readiness,
      mappings: evidenceMappings(readiness),
    };
  }
  modelSettings() {
    return (
      this.db.prepare("SELECT provider,model FROM model_preferences WHERE singleton=1").get() ?? {
        provider: "ollama",
        model: null,
      }
    );
  }

  profile() {
    const row = this.db.prepare("SELECT display_name FROM local_profile WHERE singleton=1").get();
    return { displayName: row?.display_name ?? "" };
  }

  setProfile(displayName) {
    this.db.prepare(
      "INSERT INTO local_profile VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET display_name=excluded.display_name",
    ).run(displayName);
    return { displayName };
  }
  setModel(provider, model) {
    this.db
      .prepare(
        "INSERT INTO model_preferences VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET provider=excluded.provider,model=excluded.model",
      )
      .run(provider, model);
    return this.modelSettings();
  }
  list() {
    return this.db
      .prepare(
        `SELECT p.id,p.name,p.scope,p.framework,p.createdAt,p.updatedAt,
          (SELECT count(*) FROM artifacts a WHERE a.projectId=p.id) AS artifactCount,
          (SELECT coalesce(sum(json_array_length(a.metadata,'$.findings')),0) FROM artifacts a WHERE a.projectId=p.id) AS findingCount,
          (SELECT count(*) FROM reviews r WHERE r.projectId=p.id) AS reviewCount
          FROM projects p ORDER BY p.createdAt DESC,p.rowid DESC`,
      )
      .all();
  }
  triage(projectId, findingId, state) {
    if (!["potential", "confirmed", "accepted", "resolved", "false_positive"].includes(state))
      throw invalid("Choose a supported finding state.");
    return this.transact(() => {
      const project = this.get(projectId);
      const finding = project.findings.find((item) => item.id === findingId);
      if (!finding) throw invalid("Finding not found in this assessment.", 404);
      if (finding.state === state) return project;
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO finding_events(artifactId,findingId,state,createdAt) VALUES(?,?,?,?)")
        .run(finding.evidence[0].id, findingId, state, now);
      // Triage changes the local workflow, while the evidence reviewed by a model stays the same.
      this.db.prepare("UPDATE projects SET updatedAt=? WHERE id=?").run(now, projectId);
      return this.get(projectId);
    });
  }
  create(name, scope, key = framework) {
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO projects(id,name,scope,framework,createdAt,updatedAt) VALUES(?,?,?,?,?,?)")
      .run(id, name, scope, key, now, now);
    return this.get(id);
  }
  touch(id) {
    this.db
      .prepare("UPDATE projects SET updatedAt=?,revision=revision+1 WHERE id=?")
      .run(new Date().toISOString(), id);
  }
  update(id, changes) {
    return this.transact(() => {
      const p = this.get(id);
      this.db
        .prepare("UPDATE projects SET name=?,scope=?,framework=? WHERE id=?")
        .run(changes.name ?? p.name, changes.scope ?? p.scope, changes.framework ?? p.framework, id);
      this.touch(id);
      return this.get(id);
    });
  }
  monitor(id, ids, state, reason, expectedFramework) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100)
      throw invalid("Select valid framework controls.");
    if (!["monitored", "excluded"].includes(state)) throw invalid("Choose monitored or excluded.");
    return this.transact(() => {
      const project = this.get(id);
      if (expectedFramework !== undefined && expectedFramework !== project.framework)
        throw invalid("Framework selection changed; refresh the assessment.", 409);
      if (!ids.every((i) => hasControl(i, project.framework))) throw invalid("Unknown framework control.");
      const write = this.db.prepare(
        "INSERT INTO control_states VALUES(?,?,?,?,?,?) ON CONFLICT(projectId,framework,controlId) DO UPDATE SET state=excluded.state,reason=excluded.reason,updatedAt=excluded.updatedAt",
      );
      const now = new Date().toISOString();
      for (const controlId of new Set(ids))
        write.run(id, project.framework, controlId, state, state === "excluded" ? reason : "", now);
      this.touch(id);
      return this.get(id);
    });
  }
  delete(id) {
    if (!this.db.prepare("DELETE FROM projects WHERE id=?").run(id).changes)
      throw invalid("Assessment not found.", 404);
  }
  attach(projectId, artifact, content) {
    const digest = artifactDigest(artifact, content);
    return this.transact(() => {
      const p = this.get(projectId);
      if (artifact.kind === "compliance_attachment" && p.framework !== artifact.controlFramework)
        throw invalid("The scope's framework changed. Refresh and select a control again.", 409);
      if (this.db.prepare("SELECT id FROM artifacts WHERE projectId=? AND digest=?").get(projectId, digest))
        return p;
      const bytes = p.artifacts.reduce((n, a) => n + a.sizeBytes, 0);
      if (
        p.artifacts.length >= 100 ||
        p.findings.length + artifact.findings.length > 2000 ||
        bytes + artifact.sizeBytes > 12 * 1024 * 1024
      )
        throw invalid("Assessment limit reached (100 files, 2,000 findings or 12 MiB).", 413);
      this.db
        .prepare("INSERT INTO artifacts(id,projectId,digest,metadata,content) VALUES(?,?,?,?,?)")
        .run(artifact.id, projectId, digest, JSON.stringify(artifact), content);
      this.touch(projectId);
      return this.get(projectId);
    });
  }
  #complianceEvidence(projectId, id) {
    const row = this.db
      .prepare("SELECT metadata,content FROM artifacts WHERE projectId=? AND id=?")
      .get(projectId, id);
    if (!row) throw invalid("Evidence file not found.", 404);
    const artifact = JSON.parse(row.metadata);
    if (!isManageableComplianceEvidence(artifact))
      throw invalid("This file is managed by its assessment.", 409);
    return { artifact, content: row.content };
  }
  changeComplianceEvidenceControl(projectId, id, controlId, controlFramework) {
    if (typeof controlFramework !== "string" || !hasControl(controlId, controlFramework))
      throw invalid("Select a valid framework control.");
    return this.transact(() => {
      const { artifact, content } = this.#complianceEvidence(projectId, id);
      const project = this.db.prepare("SELECT framework FROM projects WHERE id=?").get(projectId);
      if (project.framework !== controlFramework)
        throw invalid("The scope's framework changed. Refresh and select a control again.", 409);
      if (artifact.kind === "compliance_attachment" && artifact.controlId === controlId &&
        artifact.controlFramework === controlFramework) return this.get(projectId);
      const updated = {
        ...artifact, kind: "compliance_attachment", controlId, controlFramework,
        updatedAt: new Date().toISOString(),
      };
      const digest = artifactDigest(updated, content);
      if (this.db.prepare("SELECT id FROM artifacts WHERE projectId=? AND digest=? AND id<>?").get(projectId, digest, id))
        throw invalid("The same file is already linked to that control.", 409);
      this.db.prepare("UPDATE artifacts SET digest=?,metadata=? WHERE projectId=? AND id=?")
        .run(digest, JSON.stringify(updated), projectId, id);
      this.touch(projectId);
      return this.get(projectId);
    });
  }
  detach(projectId, id, { complianceEvidenceOnly = false } = {}) {
    return this.transact(() => {
      if (complianceEvidenceOnly) this.#complianceEvidence(projectId, id);
      if (!this.db.prepare("DELETE FROM artifacts WHERE projectId=? AND id=?").run(projectId, id).changes)
        throw invalid("Evidence file not found.", 404);
      this.touch(projectId);
      return this.get(projectId);
    });
  }
  original(projectId, id) {
    const row = this.db
      .prepare("SELECT metadata,content FROM artifacts WHERE id=? AND projectId=?")
      .get(id, projectId);
    if (!row) throw invalid("Evidence file not found.", 404);
    const meta = JSON.parse(row.metadata);
    return { name: meta.name, kind: meta.kind, content: row.content };
  }
  saveReview(projectId, revision, review) {
    return this.transact(() => {
      const result = this.db
        .prepare("UPDATE projects SET updatedAt=? WHERE id=? AND revision=?")
        .run(new Date().toISOString(), projectId, revision);
      if (!result.changes)
        throw invalid(
          "The assessment changed during review. Reopen it before starting another review.",
          409,
        );
      this.db
        .prepare("INSERT INTO reviews VALUES(?,?,?)")
        .run(review.id, projectId, JSON.stringify(review));
      return this.get(projectId);
    });
  }
  close() {
    this.db.close();
  }
}
