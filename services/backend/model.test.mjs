import assert from "node:assert/strict";
import test from "node:test";
import { listModels, reviewFindings } from "./model.mjs";

const input = { model: "local:demo", findings: [], evidence: [{ id: "E1", title: "Peer approval", excerpt: "Two reviewers signed." }] };

test("Ollama reviews selected evidence without sending private metadata or tools", async t => {
  const routes = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url);
    assert.equal(route.origin, "http://127.0.0.1:11434");
    assert.equal(options.redirect, "error");
    routes.push(route.pathname);
    if (route.pathname === "/api/tags") return Response.json({ models: [{name: "local:demo"}, {name:"other:cloud"}] });
    if (route.pathname === "/api/show") return Response.json({ details: { parameter_size: "2B" } });
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.equal(body.stream, false);
    assert.match(body.messages[1].content, /E1/);
    assert.doesNotMatch(body.messages[1].content, /PRIVATE_CANARY/);
    return Response.json({ message: { content: " Review evidence E1. " } });
  });
  assert.deepEqual((await listModels()).models, ["local:demo"]);
  const result = await reviewFindings({ ...input, evidence: [{...input.evidence[0], filePath:"PRIVATE_CANARY"}] });
  assert.deepEqual(result, { provider:"ollama",model:"local:demo",text:"Review evidence E1." });
  assert.deepEqual(routes, ["/api/tags", "/api/show", "/api/chat"]);
});

test("a cloud alias cannot silently send evidence through the local provider", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ remote_host:"https://example.invalid", details:{parameter_size:"2B"} }));
  await assert.rejects(reviewFindings(input), /installed local/);
  assert.equal(fetch.mock.callCount(), 1);
  await assert.rejects(reviewFindings({...input, model:"example:cloud"}), /installed local/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("review rejects missing, excessive or unsupported inputs before provider dispatch", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected request"));
  await assert.rejects(reviewFindings({...input, evidence:[]}), /Select evidence/);
  await assert.rejects(reviewFindings({...input, scope:"x".repeat(12001)}), /fewer evidence/);
  await assert.rejects(reviewFindings({...input, provider:"http://example.invalid"}), /Choose Ollama/);
  await assert.rejects(reviewFindings({...input, workflow:"run"}), /Choose compliance/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("provider cancellation and outages surface safe errors", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("PRIVATE_CANARY"); });
  await assert.rejects(listModels(), /Start Ollama/);
  await assert.rejects(reviewFindings({...input, signal:AbortSignal.abort()}), /cancelled/);
});

test("a response cut off at the token limit is never saved as a completed review", async t => {
  t.mock.method(globalThis, "fetch", async (url) => url.endsWith("/api/show")
    ? Response.json({ details:{parameter_size:"2B"} })
    : Response.json({ done_reason:"length", message:{content:"An incomplete observation"} }));
  await assert.rejects(reviewFindings(input), /before completing/);
});

test("BYOK sends a text-only code review to the fixed API and redacts authentication errors", async t => {
  // Node's test runner isolates each test file in its own process.
  process.env.NULLSQUARE_OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => { delete process.env.NULLSQUARE_OPENAI_API_KEY; });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer synthetic-test-key");
    if (url.endsWith("/models")) return new Response("PRIVATE_CANARY", {status:401});
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.tools, undefined);
    assert.match(body.messages[0].content, /static analysis/);
    return Response.json({choices:[{message:{content:"Review line 4."}}]});
  });
  assert.equal((await reviewFindings({...input, provider:"openai", workflow:"code-review"})).text, "Review line 4.");
  await assert.rejects(listModels({provider:"openai"}), /provider rejected the credentials/);
  delete process.env.NULLSQUARE_OPENAI_API_KEY;
  await assert.rejects(listModels({provider:"openai"}), /Set NULLSQUARE_OPENAI_API_KEY/);
});
