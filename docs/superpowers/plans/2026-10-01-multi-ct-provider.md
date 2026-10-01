# Multi CT Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CT searches resilient to crt.sh failures through sequential fallback providers and stale-cache recovery.

**Architecture:** Keep the existing Worker route and cache keys. Split each upstream into an independently timed request and normalizer, then use a Provider Manager to sequence eligible providers, cache successful normalized data, and preserve useful stale results.

**Tech Stack:** Cloudflare Workers, Cache API, vanilla JavaScript, Node.js test runner, Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-01-multi-ct-provider-design.md`

## Global Constraints

- Preserve `GET /api/search?domain=example.com` and `?q=` sharing behavior.
- Do not add persistent storage, accounts, history, scanning, enumeration, or parallel provider aggregation.
- Keep Provider origins hard-coded; preserve existing UI layout and interactions.
- Keep `CACHE_TTL=21600` and `STALE_CACHE_TTL=604800`; apply independent Provider cooldowns.
- Run `npm test` and `npm run check` before completion.

## Review Focus

- Wildcard results must remain valid while out-of-scope hostnames are excluded; Task 1 tests this.
- HTTP 200 with malformed JSON continues the chain without leaking internal errors; Task 2 tests this.
- A zero-result fallback cannot replace non-empty stale history; Task 2 tests this.
- Timeout and oversized data continue the chain; Task 2 tests this.
- Fresh cache hits do not query a Provider and retain source metadata; Task 3 tests this.

### Task 1: Provider request and normalization primitives

**Files:** Modify `src/worker.js`; test `test/worker.test.js`.

**Interfaces:** Produces `fetchCrtSh(domain)`, `fetchCertSpotter(domain)`, `fetchCtlogs(domain)`, `normalizeCertSpotterResult(domain, raw, now)`, and `normalizeCtlogsResult(domain, raw, now)`.

- [ ] **Step 1: Write failing normalization and URL-construction tests**
  Test Cert Spotter `dns_names` filtering/deduplication and `include_subdomains=true`; test ctlogs `/v1/subdomains/example.com`; include wildcard and out-of-scope hostname assertions.
- [ ] **Step 2: Run focused tests to verify failure**
  Run `node --test test/worker.test.js`; expect missing Provider functions or URLs.
- [ ] **Step 3: Implement fixed-origin fetchers and normalizers**
  Use timeouts of 8, 6, and 6 seconds; preserve the existing success model and source IDs.
- [ ] **Step 4: Run focused tests to verify success**
  Run `node --test test/worker.test.js`; expect PASS.
- [ ] **Step 5: Commit**
  Commit `src/worker.js` and `test/worker.test.js` as `feat: add CT provider adapters`.

### Task 2: Sequential Provider Manager and stale recovery

**Files:** Modify `src/worker.js`; test `test/worker.test.js`.

**Interfaces:** Consumes Task 1 fetchers/normalizers; produces sequential cache-miss behavior with per-Provider cooldown keys and source headers.

- [ ] **Step 1: Write failing chain tests**
  Cover crt.sh-only success, fallback to Cert Spotter, fallback to ctlogs, timeout, 429 cooldown, malformed JSON, oversized response, and stale preferred over zero results.
- [ ] **Step 2: Run focused tests to verify failure**
  Run `node --test test/worker.test.js`; expect failure because the current Worker has one upstream/cooldown.
- [ ] **Step 3: Implement `PROVIDERS` sequential failover**
  Skip only cooled Providers, cache individual cooldowns, add `X-CT-Source`, and return 504 only if the last failure timed out; otherwise generic 502 without stale data.
- [ ] **Step 4: Run focused tests to verify success**
  Run `node --test test/worker.test.js`; expect PASS.
- [ ] **Step 5: Commit**
  Commit `src/worker.js` and `test/worker.test.js` as `feat: add sequential CT provider failover`.

### Task 3: Minimal source presentation and documentation

**Files:** Modify `public/app.js`, `README.md`, `src/worker.js`, and `test/worker.test.js`.

**Interfaces:** Consumes response `source` and stale status; produces lightweight localized source copy without changing UI structure or CSS layout.

- [ ] **Step 1: Write a failing cache-header regression test**
  Assert a fresh cache hit retains `X-CT-Source`, reports `X-Cache: HIT`, and never invokes fetch.
- [ ] **Step 2: Run focused test to verify failure**
  Run `node --test test/worker.test.js`; expect failure because cached responses lack source headers.
- [ ] **Step 3: Preserve source headers, add source copy, update README**
  Add a small source-label mapping to existing metadata only; document architecture, coverage limits, and cooldowns.
- [ ] **Step 4: Run unit tests and deployment preflight**
  Run `npm test && npm run check`; expect all tests and Wrangler dry run to pass.
- [ ] **Step 5: Commit**
  Commit all changed product files as `docs: describe CT provider failover`.
