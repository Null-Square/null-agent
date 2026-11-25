import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { start } from "./server.mjs";
import { reviewFindings } from "./model.mjs";
import { importArtifact, importComplianceAttachment, readiness } from "./evidence.mjs";
import { Store } from "./store.mjs";

test("relinking compliance evidence preserves bytes and rejects a duplicate destination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nullsquare evidence test "));
  const store = new Store(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true });
  });
  const project = store.create("Evidence", "Test scope", "soc2");
  const bytes = Buffer.from([0, 255, 10]);
  const file = importComplianceAttachment("evidence.bin", bytes, "CC6.1", "soc2");
  const duplicate = importComplianceAttachment("evidence.bin", bytes, "CC6.2", "soc2");
  store.attach(project.id, file, bytes);
  store.attach(project.id, duplicate, bytes);

  assert.throws(() => store.changeComplianceEvidenceControl(project.id, file.id, "CC6.2", "soc2"), { status: 409 });
  assert.deepEqual(
    store.get(project.id).mappings.filter((mapping) => mapping.evidenceIds.includes(file.id)).map((mapping) => mapping.controlId),
    ["CC6.1"],
  );
  const moved = store.changeComplianceEvidenceControl(project.id, file.id, "CC6.3", "soc2");
  assert.deepEqual(
    moved.mappings.filter((mapping) => mapping.evidenceIds.includes(file.id)).map((mapping) => mapping.controlId),
    ["CC6.3"],
  );
  assert.deepEqual(Buffer.from(store.original(project.id, file.id).content), bytes);
  const matchingUpload = importComplianceAttachment("evidence.bin", bytes, "CC6.3", "soc2");
  assert.equal(store.attach(project.id, matchingUpload, bytes).artifactCount, 2);
});

async function createOwnerFixture({ url }) {
  const post = (action, data, cookie) => fetch(url + "/api/local-owner/" + action, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(data),
  });
  const created = await post("signup", { email: "owner@example.test", password: "test-password" });
  assert.equal(created.status, 200);
  const cookie = created.headers.get("set-cookie").split(";")[0];
  const setup = await post("company", { name: "Fixture workspace", website: "example.test" }, cookie);
  assert.equal(setup.status, 200);
  return cookie;
}

async function boot(t, adapter) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nullsquare local "));
  const dataDir = path.join(root, "data");
  let instance = await start({ dataDir, port: 0, adapter });
  t.after(async () => {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  });
  const cookie = await createOwnerFixture(instance);
  const call = async (route, method = "GET", payload, headers = {}) => {
    const res = await fetch(instance.url + "/api" + route, {
      method,
      headers: { cookie, ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    return {
      status: res.status,
      body:
        res.status === 204
          ? null
          : res.headers.get("content-type").includes("json")
            ? await res.json()
            : await res.text(),
    };
  };
  return {
    call,
    get url() {
      return instance.url;
    },
    dataDir,
    async restoreCopy() {
      await instance.close();
      await cp(dataDir, path.join(root, "restored"), { recursive: true });
      instance = await start({ dataDir: path.join(root, "restored"), port: 0, adapter });
    },
  };
}

test("same-origin local persistence, retry, source export, saved review history and backup", async (t) => {
  const { call, restoreCopy } = await boot(t, {
    reviewFindings: async (v) => ({
      provider: "ollama",
      model: v.model,
      text: "Inspect referenced evidence.",
    }),
  });
  const project = (await call("/projects", "POST", { name: "Example", scope: "Example build" })).body;
  const route = "/projects/" + project.id;
  const canary = "LOCAL_TEST_NOT_A_SECRET";
  const file = {
    name: "scanner.json",
    content: JSON.stringify({
      results: [
        {
          check_id: "sample.default",
          path: "src/sample.js",
          start: { line: 3 },
          end: { line: 4 },
          extra: {
            severity: "WARNING",
            message: "Insecure default configuration. password=" + canary,
            metadata: { fix: "Choose the configured default." },
          },
        },
      ],
    }),
  };
  const p = (await call(route + "/artifacts", "POST", file)).body;
  assert.equal(p.artifacts.length, 1);
  assert.equal(p.findings[0].location.startLine, 3);
  assert.equal(p.findings[0].severity, "medium");
  assert.equal(p.mappings.find((v) => v.controlId === "PR.PS").status, "review");
  assert.equal(p.mappings.find((v) => v.controlId === "DE.CM").verdict, "not_attempted");
  assert.doesNotMatch(JSON.stringify(p), new RegExp(canary));
  assert.equal((await call(route + "/artifacts", "POST", file)).body.artifacts[0].id, p.artifacts[0].id);
  assert.equal(
    (await call(route + "/artifacts", "POST", { name: "bad.json", content: "{broken" })).status,
    400,
  );
  assert.equal((await call(route)).body.artifacts.length, 1);
  assert.doesNotMatch((await call(route + "/report.md")).body, new RegExp(canary));
  assert.equal(
    (await call(route + "/report.sarif")).body.runs[0].results[0].locations[0].physicalLocation.region
      .startLine,
    3,
  );
  for (const workflow of ["compliance", "code-review"]) {
    assert.equal((await call(route + "/review", "POST", { model: "fixture", workflow })).status, 200);
  }
  await restoreCopy();
  const restored = (await call(route)).body;
  assert.deepEqual(
    restored.reviews.map((r) => r.workflow),
    ["compliance", "code-review"],
  );
  assert.deepEqual(restored.review.artifactIds, [p.artifacts[0].id]);
  assert.equal((await call(route + "/artifacts/" + p.artifacts[0].id)).body, file.content);
  const removed = (await call(route + "/artifacts/" + p.artifacts[0].id, "DELETE")).body;
  assert.equal(removed.findings.length, 0);
  assert.equal(removed.review, null);
  assert.equal(removed.reviews.length, 2);
  assert.equal((await call(route, "DELETE")).status, 204);
  assert.equal((await call(route)).status, 404);
});

test("large assessments can review selected files with only their findings and provenance", async (t) => {
  const inputs = [];
  const { call } = await boot(t, {
    reviewFindings(args) {
      inputs.push(args);
      if (args.evidence.length === 2) return reviewFindings(args);
      return { model: args.model, provider: args.provider, text: "Reviewed chosen evidence." };
    },
  });
  const project = async (name) => "/projects/" + (await call("/projects", "POST", { name })).body.id;
  const route = await project("Selected files");
  const upload = async (projectRoute, name, content) => {
    const result = await call(projectRoute + "/artifacts", "POST", { name, content });
    assert.equal(result.status, 201);
    return result.body.artifacts.find((artifact) => artifact.name === name).id;
  };
  const source = await upload(route, "chosen.js", "// Chosen\n" + "a".repeat(7000));
  const other = await upload(route, "private.js", "// Omitted\n" + "z".repeat(7000));
  const analyzer = (name) =>
    JSON.stringify({
      results: [
        {
          check_id: name,
          path: name + ".js",
          start: { line: 1 },
          extra: { severity: "WARNING", message: name + " review" },
        },
      ],
    });
  const report = await upload(route, "chosen.json", analyzer("chosen-rule"));
  const omittedReport = await upload(route, "private.json", analyzer("private-rule"));
  const foreign = await upload(await project("Other assessment"), "other.js", "export const other = true;");
  const review = (selection) =>
    call(route + "/review", "POST", {
      model: "fixture",
      workflow: "code-review",
      ...selection,
    });
  const tooLarge = await review({});
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.body.error, /Select fewer evidence records/);
  for (const artifactIds of [[], [source, source], [source, foreign], [null], "invalid"]) {
    assert.equal((await review({ artifactIds })).status, 400);
  }
  assert.equal(inputs.length, 1);
  const selected = await review({ artifactIds: [report, source] });
  assert.equal(selected.status, 200);
  assert.deepEqual(new Set(selected.body.review.artifactIds), new Set([source, report]));
  const { evidence, findings } = inputs[1];
  assert.deepEqual(
    evidence.map((v) => v.id),
    [source],
  );
  assert.deepEqual(
    findings.flatMap((finding) => finding.evidence.map((v) => v.id)),
    [report],
  );
  const sent = JSON.stringify({ evidence, findings });
  assert.ok(!sent.includes(other) && !sent.includes(omittedReport));
  assert.doesNotMatch(sent, /Omitted|private-rule/);
  assert.equal((await call(route)).body.artifacts.length, 4);
});

test("local finding triage records actual transitions once and keeps evidence ownership and counts", async (t) => {
  const { call, restoreCopy } = await boot(t, {
    reviewFindings: async () => ({ model: "fixture", provider: "ollama", text: "Review saved." }),
  });
  const project = (await call("/projects", "POST", { name: "Review" })).body;
  const other = (await call("/projects", "POST", { name: "Other" })).body;
  const route = "/projects/" + project.id;
  const data = [
    {
      title: "Recorded rule",
      description: "Imported evidence.",
      severity: "high",
      cvssScore: 0,
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N",
      assetValue: "https://test:fixture@example.test/private?q=fixture",
      assetKind: "url",
      state: "confirmed",
      history: [{ type: "status_changed" }],
    },
    { title: "Severity only", description: "No assessment metadata.", severity: "critical" },
  ];
  const file = { name: "findings.json", content: JSON.stringify(data) };
  const imported = (await call(route + "/artifacts", "POST", file)).body;
  const [f, bare] = imported.findings;
  assert.equal(f.cvssScore, 0);
  assert.equal(f.cvssVector, data[0].cvssVector);
  assert.equal(f.assetValue, "https://example.test");
  assert.equal(f.assetKind, "url");
  assert.equal(f.state, "potential");
  assert.deepEqual(
    f.history.map((e) => [e.type, e.createdAt]),
    [["imported", imported.artifacts[0].createdAt]],
  );
  for (const key of ["assetValue", "assetKind", "cvssScore", "cvssVector"])
    assert.ok(!Object.hasOwn(bare, key));

  await call(route + "/review", "POST", { model: "fixture" });
  const endpoint = "/findings/" + encodeURIComponent(f.id);
  const patch = (state) => call(route + endpoint, "PATCH", { state });
  assert.equal(
    (await call("/projects/" + other.id + endpoint, "PATCH", { state: "accepted" })).status,
    404,
  );
  assert.equal((await patch("verified-by-scanner")).status, 400);
  await Promise.all([patch("confirmed"), patch("confirmed")]);
  const resolved = (await patch("resolved")).body;
  assert.equal(resolved.review.model, "fixture");
  assert.equal(resolved.revision, imported.revision);
  await restoreCopy();
  const persisted = (await call(route + "/artifacts", "POST", file)).body.findings[0];
  assert.equal(persisted.state, "resolved");
  assert.deepEqual(
    persisted.history.map((e) => [e.fromStatus, e.toStatus]),
    [
      [undefined, "potential"],
      ["potential", "confirmed"],
      ["confirmed", "resolved"],
    ],
  );
  assert.equal(new Set(persisted.history.map((e) => e.id)).size, 3);
  const counts = async () =>
    (await call("/projects")).body
      .map((row) => [row.name, row.findingCount, row.artifactCount, row.reviewCount])
      .sort();
  assert.deepEqual(await counts(), [
    ["Fixture workspace", 0, 0, 0],
    ["Other", 0, 0, 0],
    ["Review", 2, 1, 1],
  ]);
  await call(route + "/artifacts/" + imported.artifacts[0].id, "DELETE");
  assert.equal((await patch("accepted")).status, 404);
  assert.deepEqual(await counts(), [
    ["Fixture workspace", 0, 0, 0],
    ["Other", 0, 0, 0],
    ["Review", 0, 0, 1],
  ]);
  const replacement = (await call(route + "/artifacts", "POST", file)).body.findings[0];
  assert.equal(replacement.state, "potential");
  assert.notEqual(replacement.id, f.id);
});

test("v6 findings retain their IDs and recover original scanner facts on migration", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nullsquare-v6-"));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const original = JSON.stringify({
    "template-id": "fixture",
    host: "example.test",
    info: {
      name: "Reported issue",
      severity: "medium",
      classification: { "cvss-score": 5.3 },
    },
  });
  const artifact = importArtifact("scanner.json", original);
  const finding = artifact.findings[0];
  delete finding.cvssScore;
  delete finding.assetValue;
  const conn = new DatabaseSync(path.join(directory, "workspace.sqlite"));
  conn.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,scope TEXT,framework TEXT,createdAt TEXT,updatedAt TEXT,revision INTEGER);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,projectId TEXT REFERENCES projects(id),digest TEXT,metadata TEXT,content TEXT,UNIQUE(projectId,digest));
    INSERT INTO projects VALUES('old','Previous version','','nist_csf','created','updated',1);
    PRAGMA user_version=6;
  `);
  conn
    .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
    .run(artifact.id, "old", "digest", JSON.stringify(artifact), original);
  conn.close();
  app = await start({ dataDir: directory, port: 0 });
  const headers = { cookie: await createOwnerFixture(app) };
  const project = await (await fetch(app.url + "/api/projects/old", { headers })).json();
  assert.equal(project.findings[0].id, finding.id);
  assert.equal(project.findings[0].cvssScore, 5.3);
  assert.equal(project.findings[0].assetValue, "example.test");
  assert.equal(project.findings[0].state, "potential");
  assert.equal(project.findings[0].history[0].createdAt, artifact.createdAt);
  assert.equal(
    await (await fetch(app.url + "/api/projects/old/artifacts/" + artifact.id, { headers })).text(),
    original,
  );
});

test("cross-site reads and writes, host rebinding, oversized inputs and traversal names are rejected", async (t) => {
  const { call, url } = await boot(t);
  assert.equal(
    (await call("/projects", "POST", { name: "x" }, { origin: "https://foreign.example" })).status,
    403,
  );
  assert.equal((await call("/projects", "GET", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    http
      .get(url + "/api/projects", { headers: { host: "foreign.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on("error", reject);
  });
  assert.equal(rebound, 403);
  assert.equal(
    (await call("/projects", "POST", { name: "x" }, { "content-type": "text/plain" })).status,
    415,
  );
  const p = (await call("/projects", "POST", { name: "x" })).body;
  const send = (file) => call("/projects/" + p.id + "/artifacts", "POST", file);
  assert.equal((await send({ name: "../bad.json", content: "[]" })).status, 400);
  assert.equal((await send({ name: "oversize.txt", content: "a".repeat(2200000) })).status, 413);
  assert.deepEqual((await call("/projects/" + p.id)).body.artifacts, []);
});

test("changed evidence and cancellation prevent stale results from committing", async (t) => {
  let started, finish;
  const ready = () =>
    new Promise((resolve) => {
      started = resolve;
    });
  const adapter = {
    reviewFindings: ({ signal }) =>
      new Promise((resolve, reject) => {
        finish = () => resolve({ model: "fixture", provider: "ollama", text: "First input" });
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        started();
      }),
  };
  const { call } = await boot(t, adapter);
  const p = (await call("/projects", "POST", { name: "Sample" })).body;
  const route = "/projects/" + p.id;
  await call(route + "/artifacts", "POST", { name: "note.txt", content: "Risk review." });
  assert.equal(
    (await call(route + "/review", "POST", { model: "fixture", provider: "openai" })).status,
    400,
  );
  const review = () => call(route + "/review", "POST", { model: "fixture" });
  let next = ready();
  const first = review();
  await next;
  assert.equal((await review()).status, 409);
  await call(route, "PATCH", { scope: "changed" });
  finish();
  assert.equal((await first).status, 409);
  next = ready();
  const second = review();
  await next;
  assert.equal((await call(route + "/review/cancel", "POST", {})).status, 200);
  assert.equal((await second).status, 409);
  assert.deepEqual((await call(route)).body.reviews, []);
});

test("legacy matching prioritizes explicit CWE evidence and records no automatic control verdict", () => {
  const a = importArtifact(
    "evidence.json",
    JSON.stringify([
      { title: "Synthetic issue", severity: "low", description: "Unit fixture", cweIds: ["CWE-200"] },
    ]),
  );
  const m = readiness([a]);
  assert.deepEqual(m.find((r) => r.controlId === "ID.RA").evidenceIds, [a.id]);
  assert.ok(m.every((r) => r.verdict === "not_attempted"));
});

test("workspace migrates from v1 and rejects newer schema without destructive changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nullsquare-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "workspace.sqlite");
  let conn = new DatabaseSync(file);
  conn.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,scope TEXT,framework TEXT,createdAt TEXT,updatedAt TEXT,revision INTEGER,review TEXT); PRAGMA user_version=1",
  );
  conn
    .prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)")
    .run("p", "Demo", "", "nist_csf", "t", "t", 1, JSON.stringify({ id: "old", text: "Saved" }));
  conn.close();
  const local = await start({ dataDir: root, port: 0 });
  const headers = { cookie: await createOwnerFixture(local) };
  const migrated = await (await fetch(local.url + "/api/projects/p", { headers })).json();
  assert.equal(migrated.reviews[0].id, "old");
  assert.equal(migrated.review.id, "old");
  await local.close();
  conn = new DatabaseSync(file);
  conn.exec("PRAGMA user_version=99");
  conn.close();
  await assert.rejects(start({ dataDir: root, port: 0 }), /newer application/);
  conn = new DatabaseSync(file);
  assert.equal(conn.prepare("SELECT name FROM projects").get().name, "Demo");
  conn.close();
});
test("all tagged framework catalogs have independent persisted monitoring and evidence links", async (t) => {
  const { call, restoreCopy } = await boot(t);
  const frameworks = (await call("/frameworks")).body;
  const sizes = { soc2: 33, gdpr: 19, hipaa: 26, pci_dss: 41, iso27001: 35, nist_csf: 22 };
  assert.equal(frameworks.length, 6);
  const route = "/projects/" + (await call("/projects", "POST", { name: "Coverage" })).body.id;
  const expected = [];
  for (const { key, controlCount } of frameworks) {
    assert.equal(controlCount, sizes[key]);
    const p = (await call(route, "PATCH", { framework: key })).body;
    assert.equal(p.framework, key);
    const summary = p.readiness.frameworks[0],
      control = summary.controls[0];
    assert.equal(summary.controls.length, sizes[key]);
    assert.equal(summary.key, key);
    assert.ok(summary.outcomeCounts.not_checked > 0);
    const result = (
      await call(route + "/artifacts", "POST", {
        name: "control.txt",
        content: "Signed record metadata for offline review.",
        controlId: control.id,
        framework: key,
      })
    ).body;
    assert.equal(result.mappings.find((r) => r.controlId === control.id).evidenceIds.length, 1);
    assert.equal(
      (
        await call(route + "/controls", "PATCH", {
          controlIds: [control.id, "invalid"],
          monitoring: "excluded",
          reason: "Test scope.",
        })
      ).status,
      400,
    );
    const excluded = (
      await call(route + "/controls", "PATCH", {
        framework: key,
        controlIds: [control.id],
        monitoring: "excluded",
        reason: "Test scope.",
      })
    ).body;
    assert.equal(excluded.readiness.frameworks[0].controls[0].outcome, "excluded");
    expected.push([key, control.id]);
  }
  await restoreCopy();
  for (const [key, id] of expected) {
    const summary = (await call(route + "/readiness?framework=" + key)).body.frameworks[0];
    const control = summary.controls.find((c) => c.id === id);
    assert.equal(control.monitoring.exclusionReason, "Test scope.");
    assert.equal(control.evidence.length, 1);
    assert.equal(summary.frameworkProfile?.functions.length, key === "nist_csf" ? 6 : undefined);
  }
  assert.equal((await call(route + "/readiness?framework=unknown")).status, 400);
  assert.equal((await call(route)).body.framework, "nist_csf");
});

test("source and patch contents reach review intact, anchors resolve exact immutable lines, and preferences persist", async (t) => {
  let input;
  const { call, restoreCopy } = await boot(t, {
    reviewFindings: async (args) => {
      input = args;
      return { provider: args.provider, model: args.model, text: "Review complete." };
    },
  });
  const route = "/projects/" + (await call("/projects", "POST", { name: "Code" })).body.id;
  const source = "let first=1;\r\nlet repeat=first;\r\nlet repeat=first;\r\n";
  const patch = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-let first=1;\n+const first=1;\n";
  const artifact = (await call(route + "/artifacts", "POST", { name: "example.ts", content: source })).body
    .artifacts[0];
  assert.equal(artifact.sourcePreview.startLine, 1);
  assert.equal(artifact.kind, "source");
  assert.equal(
    (
      await call(route + "/artifacts/" + artifact.id + "/anchor", "POST", {
        sourceAnchor: "let repeat=first;",
      })
    ).status,
    400,
  );
  const resolved = (
    await call(route + "/artifacts/" + artifact.id + "/anchor", "POST", {
      sourceAnchor: "let repeat=first;",
      occurrence: 2,
    })
  ).body;
  assert.equal(resolved.startLine, 2);
  assert.equal(resolved.endLine, 4);
  await call(route + "/artifacts", "POST", { name: "change.patch", content: patch });
  assert.equal(
    (await call(route + "/artifacts", "POST", { name: "huge.py", content: "a".repeat(8193) })).status,
    400,
  );
  assert.equal(
    (await call("/settings/model", "PUT", { provider: "ollama", model: "fixture" })).status,
    200,
  );
  await restoreCopy();
  assert.deepEqual((await call("/settings/model")).body, { provider: "ollama", model: "fixture" });
  await call(route + "/artifacts", "POST", { name: "unrelated.md", content: "Policy evidence." });
  const review = (await call(route + "/review", "POST", { workflow: "code-review" })).body.review;
  assert.equal(review.model, "fixture");
  assert.deepEqual(
    review.artifactIds,
    input.evidence.map((e) => e.id),
  );
  assert.deepEqual(
    input.evidence.map((e) => e.excerpt),
    [source, patch],
  );
  assert.equal(input.evidence[0].id, artifact.id);
  assert.equal(input.evidence[0].title, "example.ts");
  assert.deepEqual((await call("/settings/model", "PUT", { provider: "ollama", model: null })).body, {
    provider: "ollama",
    model: null,
  });
});
