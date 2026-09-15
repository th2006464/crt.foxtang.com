const CRT_SH_ORIGIN = "https://crt.sh";
const DEFAULT_CACHE_TTL = 21_600;
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_DOMAIN_LENGTH = 253;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function normalizeDomain(input) {
  if (typeof input !== "string") return "";
  const value = input.trim();
  if (!value) return "";

  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export function isValidDomain(domain) {
  if (!domain || domain.length > MAX_DOMAIN_LENGTH || !domain.includes(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  return domain.split(".").every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
  );
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function belongsToDomain(name, domain) {
  const hostname = name.startsWith("*.") ? name.slice(2) : name;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function domainDepth(name) {
  return (name.startsWith("*.") ? name.slice(2) : name).split(".").length;
}

export function normalizeCrtShResult(domain, raw, now = new Date()) {
  const records = Array.isArray(raw) ? raw : [];
  const domains = new Set();
  const certificates = new Map();

  for (const item of records) {
    if (!item || typeof item !== "object") continue;
    const names = [item.common_name, ...String(item.name_value || "").split(/\r?\n/)]
      .map(normalizeName)
      .filter((name) => name && belongsToDomain(name, domain));
    names.forEach((name) => domains.add(name));

    const id = Number(item.id);
    const key = Number.isSafeInteger(id) && id > 0
      ? String(id)
      : [item.serial_number, item.not_before, item.not_after, item.common_name].join("|");
    if (certificates.has(key)) continue;

    const notBefore = item.not_before || null;
    const notAfter = item.not_after || null;
    const start = notBefore ? new Date(notBefore).getTime() : Number.NaN;
    const end = notAfter ? new Date(notAfter).getTime() : Number.NaN;
    const time = now.getTime();
    const status = Number.isFinite(start) && start > time
      ? "not_yet_valid"
      : Number.isFinite(end) && end < time
        ? "expired"
        : "valid";

    certificates.set(key, {
      id: Number.isSafeInteger(id) && id > 0 ? id : null,
      commonName: normalizeName(item.common_name) || null,
      names: [...new Set(names)].sort(),
      issuer: typeof item.issuer_name === "string" ? item.issuer_name : "",
      notBefore,
      notAfter,
      serialNumber: typeof item.serial_number === "string" ? item.serial_number : "",
      status,
    });
  }

  const sortedDomains = [...domains].sort((a, b) => {
    const wildcardDiff = Number(a.startsWith("*.")) - Number(b.startsWith("*."));
    return wildcardDiff || domainDepth(a) - domainDepth(b) || a.localeCompare(b);
  });
  const sortedCertificates = [...certificates.values()].sort(
    (a, b) => Date.parse(b.notBefore || 0) - Date.parse(a.notBefore || 0),
  );

  return {
    success: true,
    domain,
    source: "crt.sh",
    queryTime: now.toISOString(),
    count: sortedCertificates.length,
    domains: sortedDomains,
    certificates: sortedCertificates,
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function jsonError(error, message, status) {
  return jsonResponse({ success: false, error, message }, status, {
    "Cache-Control": "no-store",
  });
}

async function readJsonWithLimit(response) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error("UPSTREAM_TOO_LARGE");
  if (!response.body) return [];

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("UPSTREAM_TOO_LARGE");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchUpstream(domain) {
  const url = new URL(CRT_SH_ORIGIN);
  url.searchParams.set("q", `%.${domain}`);
  url.searchParams.set("output", "json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "foxtang-cert-search/1.0",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handleSearch(request, env, ctx) {
  if (request.method !== "GET") {
    return jsonError("METHOD_NOT_ALLOWED", "仅支持 GET 请求。", 405);
  }

  const requestUrl = new URL(request.url);
  const domain = normalizeDomain(requestUrl.searchParams.get("domain"));
  if (!isValidDomain(domain)) {
    return jsonError("INVALID_DOMAIN", "请输入有效域名，例如 example.com。", 400);
  }

  const ttl = Math.max(60, Number.parseInt(env.CACHE_TTL, 10) || DEFAULT_CACHE_TTL);
  const cacheKey = new Request(`${requestUrl.origin}/__cache/cert/${encodeURIComponent(domain)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  let upstream;
  try {
    upstream = await fetchUpstream(domain);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return jsonError("UPSTREAM_TIMEOUT", "查询服务暂时响应较慢，请稍后重试。", 504);
    }
    return jsonError("UPSTREAM_ERROR", "公开证书数据源暂时不可用，请稍后重试。", 502);
  }
  if (!upstream.ok) {
    return jsonError("UPSTREAM_ERROR", "公开证书数据源暂时不可用，请稍后重试。", 502);
  }

  try {
    const raw = await readJsonWithLimit(upstream);
    const result = normalizeCrtShResult(domain, raw);
    const response = jsonResponse(result, 200, {
      "Cache-Control": `public, s-maxage=${ttl}`,
      "X-Cache": "MISS",
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch {
    return jsonError("INVALID_UPSTREAM_RESPONSE", "数据源返回异常，请稍后重试。", 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/search") return handleSearch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
