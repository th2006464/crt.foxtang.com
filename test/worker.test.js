import test from "node:test";
import assert from "node:assert/strict";
import worker, { isValidDomain, normalizeCertSpotterResult, normalizeCtlogsResult, normalizeCrtShResult, normalizeDomain } from "../src/worker.js";

test("normalizes URL input to a hostname", () => {
  assert.equal(normalizeDomain(" HTTPS://Example.COM/path?q=1 "), "example.com");
  assert.equal(normalizeDomain("example.com."), "example.com");
});

test("validates domains and rejects unsafe input", () => {
  assert.equal(isValidDomain("example.com"), true);
  assert.equal(isValidDomain("xn--fsqu00a.xn--0zwm56d"), true);
  assert.equal(isValidDomain("localhost"), false);
  assert.equal(isValidDomain("example.com.attacker..com"), false);
  assert.equal(normalizeDomain("javascript:alert(1)"), "");
});

test("cleans, scopes, deduplicates, and sorts crt.sh records", () => {
  const raw = [
    { id: 2, common_name: "www.example.com", name_value: "www.example.com\n*.example.com\nfakeexample.com", issuer_name: "CA 2", not_before: "2026-01-01", not_after: "2026-04-01", serial_number: "b" },
    { id: 1, common_name: "example.com", name_value: "example.com\napi.example.com\nexample.com.attacker.com", issuer_name: "CA 1", not_before: "2025-01-01", not_after: "2025-04-01", serial_number: "a" },
    { id: 2, common_name: "www.example.com", name_value: "www.example.com", issuer_name: "CA 2", not_before: "2026-01-01", not_after: "2026-04-01", serial_number: "b" },
  ];
  const result = normalizeCrtShResult("example.com", raw, new Date("2026-02-01T00:00:00Z"));
  assert.deepEqual(result.domains, ["example.com", "api.example.com", "www.example.com", "*.example.com"]);
  assert.equal(result.certificates.length, 2);
  assert.equal(result.certificates[0].id, 2);
  assert.equal(result.certificates[0].status, "valid");
  assert.equal(result.certificates[1].status, "expired");
});

test("normalizes fallback provider results within the requested domain", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  assert.deepEqual(normalizeCertSpotterResult("example.com", [{ dns_names: ["WWW.EXAMPLE.COM.", "*.example.com", "example.com.attacker.com"] }], now).domains, ["www.example.com", "*.example.com"]);
  assert.deepEqual(normalizeCtlogsResult("example.com", { subdomains: ["api", "www.example.com", "attacker.com"] }, now).domains, ["api.example.com", "www.example.com"]);
});

test("serves a recent cached result when crt.sh is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const entries = new Map();
  const cache = {
    async match(request) { return entries.get(typeof request === "string" ? request : request.url)?.clone(); },
    async put(request, response) { entries.set(typeof request === "string" ? request : request.url, response.clone()); },
  };
  globalThis.caches = { default: cache };
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 502 });

  const staleKey = "https://cert.example/__cache/cert-stale/example.com";
  await cache.put(staleKey, new Response(JSON.stringify({
    success: true, domain: "example.com", queryTime: "2026-09-15T00:00:00.000Z", domains: [], certificates: [], count: 0,
  }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=604800" } }));

  const background = [];
  try {
    const response = await worker.fetch(
      new Request("https://cert.example/api/search?domain=example.com"),
      { CACHE_TTL: "21600", STALE_CACHE_TTL: "604800", UPSTREAM_BACKOFF_TTL: "90" },
      { waitUntil(promise) { background.push(promise); } },
    );
    await Promise.all(background);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Cache"), "STALE");
    assert.equal(response.headers.get("X-Data-Freshness"), "stale");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).success, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("falls back from crt.sh to Cert Spotter in sequence", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("bad", { status: 502 });
    return Response.json([{ dns_names: ["api.example.com"] }]);
  };
  try {
    const response = await worker.fetch(new Request("https://cert.example/api/search?domain=example.com"), {}, { waitUntil() {} });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-CT-Source"), "certspotter");
    assert.match(calls[1], /include_subdomains=true/);
    assert.equal((await response.json()).domains[0], "api.example.com");
  } finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
});
