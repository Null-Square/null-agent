import express from "express";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./store.mjs";
import { renderMarkdownReport } from "./reports.mjs";
import { importArtifact, importComplianceAttachment, sourceAnchor, framework, inputText, invalid, redact } from "./evidence.mjs";
import { catalogue, hasFramework } from "./src/domains/security-ops/compliance/localReadiness.mjs";
import { createLocalOwner } from "./localOwner.mjs";
import { callbackPath, createLocalModels } from "./localModels.mjs";
import { chooseLocalFolder } from "./chooseFolder.mjs";
import * as models from "./model.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
function sarif(findings) {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "NullSquare Local" } },
        results: findings.map((f) => ({
          ...(f.ruleId ? { ruleId: f.ruleId } : {}),
          level: ["high", "critical"].includes(f.severity)
            ? "error"
            : f.severity === "medium"
              ? "warning"
              : "note",
          message: { text: f.description || f.title },
          ...(f.location
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: {
                        uri: f.location.path.split("/").map(encodeURIComponent).join("/"),
                      },
                      ...(f.location.startLine
                        ? { region: { startLine: f.location.startLine, endLine: f.location.endLine } }
                        : {}),
                    },
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };
}

export async function start({
  dataDir = process.env.NULLSQUARE_DATA_DIR || path.join(os.homedir(), ".nullsquare-local"),
  port = Number(process.env.PORT ?? 4317),
  frontend = path.resolve(directory, "../frontend/dist"),
  adapter = models,
  selectFolder = chooseLocalFolder,
  modelTransport,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("PORT must be an integer between 0 and 65535.");
  const db = new Store(dataDir);
  const account = createLocalOwner(db, { chooseFolder: selectFolder });
  const connections = createLocalModels({ account, adapter, transport: modelTransport });
  const active = new Map();
  const app = express();
  const route = "/api/projects/:id";
  const binaryUpload = /^\/api\/projects\/[^/]+\/artifacts\/file$/;
  const sendJSON = (res, status, body) => res.status(status).json(body);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const authority = req.headers.host;
    const allowed = ["localhost", "127.0.0.1"].some(
      (host) => authority === (req.socket.localPort === 80 ? host : host + ":" + req.socket.localPort),
    );
    const returningFromChatGPT = req.method === "GET" && req.path === callbackPath && authority?.startsWith("127.0.0.1");
    if (
      !allowed ||
      (!returningFromChatGPT && (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== "http://" + authority)
      ))
    )
      return res.status(403).json({ error: "Use the local application origin." });
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    if (["POST", "PATCH", "PUT"].includes(req.method) && !binaryUpload.test(req.path) && !req.is("application/json"))
      return res.status(415).json({ error: "Use application/json." });
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get(callbackPath, async (req, res) => {
    const query = new URL(req.originalUrl, "http://" + req.headers.host).searchParams;
    const message = await connections.finishChatGPT(query);
    const text = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    res.set("Cache-Control", "no-store").type("html").send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>NullSquare Models</title><main><h1>ChatGPT sign-in</h1><p>${text}</p><a href="/models">Return to Models</a></main></html>`,
    );
  });
  app.all("/api/local-owner/:action", async (req, res) => {
    const { action } = req.params;
    const session = action === "signout" ? account.readySession(req) : null;
    await account.handle(action, req, res, "http://" + req.headers.host, sendJSON);
    if (session && !account.sessionActive(session)) void connections.disconnect(session);
  });
  app.use("/api/local-models", (req, res) =>
    connections.handle(req.path.slice(1), req, res, "http://" + req.headers.host, sendJSON),
  );
  app.use("/api", (req, res, next) => {
    if (account.state(req).stage !== "ready") return res.status(401).json({ error: "Sign in to open this workspace." });
    next();
  });
  app.post(route + "/artifacts/file", express.raw({ type: "application/octet-stream", limit: "1mb", inflate: false }), (req, res) => {
    if (req.headers.origin !== "http://" + req.headers.host) throw invalid("Upload from the local app.", 403);
    let name;
    try {
      name = decodeURIComponent(req.headers["x-evidence-name"] ?? "");
    } catch {
      throw invalid("Use a valid file name.");
    }
    const content = req.body;
    const artifact = importComplianceAttachment(name, content, req.query.controlId, req.query.framework);
    res.status(201).json(db.attach(req.params.id, artifact, content));
  });
  app.use(express.json({ limit: "2mb", inflate: false }));
  app.get("/api/frameworks", (_req, res) =>
    res.json(
      Object.entries(catalogue).map(([key, { label, controls }]) => ({
        key,
        label,
        controlCount: controls.length,
      })),
    ),
  );
  app.get("/api/projects", (_req, res) => res.json(db.list()));
  const validFramework = (value) => {
    if (value !== undefined && !hasFramework(value))
      throw invalid("Choose a supported readiness framework.");
  };
  app.post("/api/projects", (req, res) => {
    const body = req.body ?? {};
    validFramework(body.framework);
    res
      .status(201)
      .json(
        db.create(
          inputText(body.name, "name", 120, true),
          inputText(body.scope ?? "", "scope", 2000),
          body.framework,
        ),
      );
  });
  app.get(route, (req, res) => res.json(db.get(req.params.id)));
  app.patch(route + "/findings/:findingId", (req, res) =>
    res.json(db.triage(req.params.id, req.params.findingId, req.body?.state)),
  );
  app.get(route + "/readiness", (req, res) => {
    validFramework(req.query.framework);
    res.json(db.get(req.params.id, req.query.framework).readiness);
  });
  app.patch(route + "/controls", (req, res) => {
    const body = req.body ?? {};
    const reason = inputText(body.reason ?? "", "reason", 2000, body.monitoring === "excluded");
    res.json(db.monitor(req.params.id, body.controlIds, body.monitoring, reason, body.framework));
  });
  app.post(route + "/artifacts/:artifactId/anchor", (req, res) => {
    const a = db.original(req.params.id, req.params.artifactId);
    if (!["source", "patch"].includes(a.kind)) throw invalid("Select a source or patch attachment.");
    res.json(sourceAnchor(a.content, a.name, req.body ?? {}));
  });
  app.patch(route, (req, res) => {
    const body = req.body ?? {};
    validFramework(body.framework);
    if (!["name", "scope", "framework"].some((field) => Object.hasOwn(body, field)))
      throw invalid("Supply a name, scope or framework.");
    const changes = {};
    if (body.framework !== undefined) changes.framework = body.framework;
    if (body.name !== undefined) changes.name = inputText(body.name, "name", 120, true);
    if (body.scope !== undefined) changes.scope = inputText(body.scope, "scope", 2000);
    res.json(db.update(req.params.id, changes));
  });
  app.delete(route, (req, res) => {
    db.delete(req.params.id);
    active.get(req.params.id)?.abort();
    res.status(204).end();
  });
  app.post(route + "/artifacts", (req, res) => {
    const project = db.get(req.params.id);
    const body = req.body ?? {};
    if (body.framework !== undefined && body.framework !== project.framework)
      throw invalid("Framework selection changed; refresh the assessment.", 409);
    res
      .status(201)
      .json(
        db.attach(
          project.id,
          importArtifact(body.name, body.content, body.controlId, project.framework),
          body.content,
        ),
      );
  });
  app.delete(route + "/artifacts/:artifactId", (req, res) =>
    res.json(db.detach(req.params.id, req.params.artifactId)),
  );
  app.patch(route + "/artifacts/:artifactId/control", (req, res) =>
    res.json(db.changeComplianceEvidenceControl(req.params.id, req.params.artifactId, req.body?.controlId, req.body?.framework)),
  );
  app.get(route + "/artifacts/:artifactId", (req, res) => {
    const a = db.original(req.params.id, req.params.artifactId);
    res.attachment(a.name).type("application/octet-stream").send(Buffer.from(a.content));
  });
  app.get(route + "/report.md", (req, res) =>
    res
      .attachment("assessment.md")
      .type("text/markdown")
      .send(renderMarkdownReport(db.get(req.params.id))),
  );
  app.get(route + "/report.sarif", (req, res) =>
    res
      .attachment("assessment.sarif")
      .type("application/sarif+json")
      .json(sarif(db.get(req.params.id).findings)),
  );
  app.get("/api/profile", (_req, res) => res.json(db.profile()));
  app.put("/api/profile", (req, res) =>
    res.json(db.setProfile(inputText(req.body?.displayName, "display name", 120))),
  );
  app.get("/api/settings/model", (req, res) => res.json(connections.selection(req) ?? db.modelSettings()));
  app.put("/api/settings/model", (req, res) => {
    const { provider, model } = req.body ?? {};
    if (!["ollama", "openai"].includes(provider)) throw invalid("Choose Ollama or OpenAI.");
    res.json(db.setModel(provider, model === null ? null : inputText(model, "model", 150, true)));
  });
  app.get("/api/models", async (req, res) => {
    try {
      res.json(await adapter.listModels({ provider: req.query.provider ?? "ollama" }));
    } catch (err) {
      throw invalid(redact(err.message), 502);
    }
  });
  app.post(route + "/review/cancel", (req, res) => {
    const run = active.get(req.params.id);
    if (!run) throw invalid("No review is running.", 409);
    run.abort();
    res.json({ cancelled: true });
  });
  app.post(route + "/review", async (req, res) => {
    const p = db.get(req.params.id);
    const connected = connections.selection(req);
    const saved = connected ?? db.modelSettings();
    const { provider = saved.provider, model = saved.model, workflow = "compliance" } = req.body ?? {};
    const providers = connected ? [connected.provider] : ["ollama", "openai"];
    if (!providers.includes(provider) || !["compliance", "code-review"].includes(workflow))
      throw invalid("Unknown provider or review workflow.");
    inputText(model, "model", 150, true);
    if (provider !== "ollama" && req.body?.sendEvidence !== true)
      throw invalid("Confirm sending this assessment scope and evidence to the selected provider.");
    if (!p.artifacts.length) throw invalid("Attach an evidence file before starting a review.");
    let artifacts = p.artifacts;
    let findings = p.findings;
    const artifactIds = req.body?.artifactIds;
    if (artifactIds !== undefined) {
      if (!Array.isArray(artifactIds) || !artifactIds.length)
        throw invalid("Select at least one evidence file.");
      const selected = new Set(artifactIds);
      if (selected.size !== artifactIds.length) throw invalid("Each evidence file may be selected once.");
      artifacts = artifacts.filter((a) => selected.has(a.id));
      if (artifacts.length !== selected.size)
        throw invalid("Select only evidence files in this assessment.");
      findings = findings.flatMap((finding) => {
        const evidence = finding.evidence.filter((entry) => selected.has(entry.id));
        return evidence.length ? [{ ...finding, evidence }] : [];
      });
    }
    if (active.has(p.id)) throw invalid("A review is already running.", 409);
    const controller = new AbortController();
    active.set(p.id, controller);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const attached = artifacts
        .filter((a) => workflow === "compliance" && a.excerpt)
        .map((a) => ({ id: a.id, title: a.name, excerpt: a.excerpt }));
      if (workflow === "code-review") {
        for (const a of artifacts.filter((a) => a.kind === "source" || a.kind === "patch")) {
          const { content } = db.original(p.id, a.id);
          if (
            provider !== "ollama" &&
            redact(content.replaceAll("\r\n", "\n")) !== content.replaceAll("\r\n", "\n")
          )
            throw invalid(
              "This source contains potentially sensitive text. Use a local model or submit a sanitized excerpt.",
            );
          attached.push({ id: a.id, title: a.name, excerpt: content });
        }
      }
      if (workflow === "code-review")
        findings = findings.filter((finding) => finding.location || finding.source === "semgrep");
      if (!attached.length && !findings.length)
        throw invalid(
          workflow === "code-review"
            ? "Attach a source file, patch or static analysis finding to run code review."
            : "Attach a note or analyzer findings for compliance review.",
        );
      const answer = await connections.review(req, {
        provider,
        model,
        workflow,
        scope: redact(p.scope),
        framework: p.framework,
        findings,
        evidence: attached,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw invalid("Review cancelled.", 409);
      const review = {
        id: randomUUID(),
        model: answer.model,
        provider: answer.provider,
        workflow,
        text: redact(inputText(answer.text, "model response", 24000, true)),
        scope: p.scope,
        evidenceRevision: p.revision,
        artifactIds: [
          ...new Set([
            ...attached.map((a) => a.id),
            ...findings.flatMap((f) => f.evidence.map((e) => e.id)),
          ]),
        ],
        framework: p.framework,
        createdAt: new Date().toISOString(),
      };
      res.json(db.saveReview(p.id, p.revision, review));
    } catch (err) {
      if (controller.signal.aborted) throw invalid("Review cancelled.", 409);
      if (err.status) throw err;
      throw invalid(redact(err.message), 502);
    } finally {
      active.delete(p.id);
    }
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API route." }));
  app.use(express.static(frontend, { index: false }));
  app.get(/.*/, (req, res) => {
    const { stage } = account.state(req);
    const landing = stage === "ready" ? "/scopes" : stage === "onboarding" ? "/onboarding" : "/auth";
    if (req.path === "/" || (req.path !== landing && (stage !== "ready" || req.path === "/auth"))) {
      return res.redirect(302, landing);
    }
    res.sendFile(path.join(frontend, "index.html"), (err) => {
      if (err && !res.headersSent)
        res.status(503).type("text/plain").send("Build the local frontend before launching.");
    });
  });
  app.use((err, _req, res, _next) => {
    if (res.destroyed || res.headersSent) return;
    const code = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
    let message = err.message;
    if (err.type === "entity.parse.failed") message = "Invalid JSON request body.";
    else if (err.type === "entity.too.large") message = "Input exceeds the allowed size.";
    else if (code === 500) message = "Local operation failed.";
    res.status(code).json({ error: message });
  });
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(port, "127.0.0.1", (err) => (err ? reject(err) : resolve(instance)));
      instance.once("error", reject);
    });
  } catch (err) {
    db.close();
    throw err;
  }
  const url = "http://127.0.0.1:" + server.address().port;
  return {
    url,
    close: async () => {
      for (const run of active.values()) run.abort();
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      db.close();
    },
  };
}

export async function main() {
  try {
    const local = await start();
    console.log("NullSquare Local: " + local.url);
    let closing = false;
    const stop = async () => {
      if (!closing) {
        closing = true;
        await local.close();
      }
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (err) {
    console.error(
      "Startup failed:",
      err.code === "EADDRINUSE" ? "Port already in use. Set PORT to another local port." : err.message,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
