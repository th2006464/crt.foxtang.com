import test from "node:test";
import assert from "node:assert/strict";
import { isValidDomain, normalizeCrtShResult, normalizeDomain } from "../src/worker.js";

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

