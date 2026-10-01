# crt.foxtang.com 多 CT 数据源容灾升级需求 V2

## 1. 项目背景

项目：`th2006464/crt.foxtang.com`

这是一个运行于 Cloudflare Workers 的轻量级 Certificate Transparency（CT）证书与子域名查询工具。

当前架构：

```text
Browser
   ↓
Cloudflare Worker
   ↓
Cloudflare Cache
   ↓
crt.sh
```

当前主要问题：crt.sh 经常出现 502、超时或响应缓慢。Cache MISS 时 crt.sh 不可用会导致查询失败。

## 2. 升级目标

第一阶段接入：

1. crt.sh
2. SSLMate Cert Spotter
3. ctlogs.dev

故障切换顺序：

```text
crt.sh
   ↓ failure
Cert Spotter
   ↓ failure
ctlogs.dev
   ↓ failure
Stale Cache
```

ctlogs.dev 不作为 crt.sh 的完整等价替代。crt.sh 继续作为主要历史 CT 数据源；Cert Spotter 为第一备用；ctlogs.dev 为第二备用。

继续保持：No D1、No KV、No R2、No Durable Objects、No persistent database、No login、No query history。

## 3. 查询原则

默认采用 Sequential Failover，不要每次并行请求三个 Provider。

Cache HIT 时直接返回，不访问 Provider。

Cache MISS 时依次尝试 crt.sh、Cert Spotter、ctlogs.dev，全部失败后使用 stale cache。

## 4. crt.sh Provider

继续使用现有 crt.sh JSON 查询方式。

保留 `normalizeCrtShResult()`，建议将 `fetchUpstream()` 重命名为 `fetchCrtSh()`。

## 5. Cert Spotter Provider

Cert Spotter 为第一备用数据源。

查询必须使用目标根域名，并启用：

```text
include_subdomains=true
```

重点解析 `dns_names`，提取属于目标根域名范围内的 hostname。

实现：

```js
async function fetchCertSpotter(domain)
function normalizeCertSpotterResult(domain, raw)
```

如果 issuer、serialNumber、notBefore、notAfter 等字段无法直接获得，允许为空，不要为了补齐字段额外大量调用 API。

## 6. ctlogs.dev Provider

ctlogs.dev 为第二备用数据源。

本项目核心需求是查询根域名及二级、三级等子域名，因此必须优先使用：

```text
/v1/subdomains/{domain}
```

例如：

```text
/v1/subdomains/foxtang.com
```

不要只使用 `/v1/domain/{domain}`。

实现：

```js
async function fetchCtlogs(domain)
function normalizeCtlogsResult(domain, raw)
```

ctlogs.dev 免费/匿名数据历史覆盖可能有限，因此没有发现某个子域名不代表该子域名从未存在。

## 7. 统一数据模型

所有 Provider 转换为当前前端兼容结构：

```json
{
  "success": true,
  "domain": "example.com",
  "source": "crt.sh",
  "queryTime": "2026-10-01T00:00:00.000Z",
  "count": 123,
  "domains": [
    "example.com",
    "www.example.com",
    "api.example.com"
  ],
  "certificates": []
}
```

`source` 可为：`crt.sh`、`certspotter`、`ctlogs.dev`。

## 8. 子域名标准化与去重

所有 Provider 返回 hostname 后统一小写、去尾部点号，并验证：

```text
hostname === domain
```

或者：

```text
hostname.endsWith("." + domain)
```

保留合法 wildcard，例如 `*.example.com`。

使用 Set 或等价机制去重，保持现有排序体验。

## 9. Provider Manager

建议：

```js
const PROVIDERS = [
  { id: "crt.sh", query: fetchCrtSh, normalize: normalizeCrtShResult },
  { id: "certspotter", query: fetchCertSpotter, normalize: normalizeCertSpotterResult },
  { id: "ctlogs.dev", query: fetchCtlogs, normalize: normalizeCtlogsResult }
];
```

以下情况自动尝试下一个 Provider：

- HTTP 429
- HTTP 500/502/503/504
- Network Error
- Timeout
- Invalid JSON
- Response Too Large
- Unexpected Response Format

## 10. Empty Result 特殊处理

区分 Provider Failure 与 HTTP 200 但无结果。

如果备用 Provider 返回 0 results，而 stale cache 中已有有效历史数据，优先返回 stale cache，避免数据覆盖范围差异造成误导。

## 11. 超时

建议：

```text
crt.sh         8 秒
Cert Spotter   6 秒
ctlogs.dev     6 秒
```

整个 Provider Chain 控制在约 20 秒以内，使用 AbortController。

## 12. Provider 独立 Backoff

每个 Provider 独立 cooldown，例如：

```text
/__cache/provider-backoff/crtsh
/__cache/provider-backoff/certspotter
/__cache/provider-backoff/ctlogs
```

crt.sh 故障后短期直接跳到 Cert Spotter，而不是阻塞所有 Provider。

429 同样进入对应 Provider cooldown 并继续下一 Provider。

## 13. Cloudflare Cache

继续：

```text
CACHE_TTL = 21600
STALE_CACHE_TTL = 604800
```

缓存最终标准化结果，不按 Provider 分 Cache Key。

继续使用：

```text
/__cache/cert/{domain}
```

## 14. Response Headers

继续使用：

```text
X-Cache: HIT / MISS / STALE
```

新增：

```text
X-CT-Source: crt.sh
X-CT-Source: certspotter
X-CT-Source: ctlogs.dev
```

## 15. 前端

不要重新设计 UI。

仅增加轻量数据源提示，例如：

```text
数据来源：crt.sh
数据来源：Cert Spotter
数据来源：ctlogs.dev
```

stale cache 可显示“数据来源：crt.sh · 缓存数据”。

不要向普通用户暴露具体 502、429 等内部故障。

## 16. 安全与隐私

所有 Provider Origin 必须硬编码，禁止用户通过参数指定任意 upstream，继续防止 SSRF。

应用自身不得主动持久化用户 IP、查询历史、搜索域名历史或 User-Agent 历史。

## 17. API 向后兼容

必须继续支持：

```text
GET /api/search?domain=example.com
```

不得修改 API Path，不得增加新的必填参数。

现有 `?q=example.com` 分享链接必须继续工作。

## 18. 测试要求

至少覆盖：

1. crt.sh 200 → source=crt.sh，且不调用备用源。
2. crt.sh 502 → Cert Spotter 200 → source=certspotter。
3. crt.sh timeout → Cert Spotter 200。
4. crt.sh fail + Cert Spotter fail → ctlogs.dev 200。
5. 验证 ctlogs.dev 使用 `/v1/subdomains/{domain}`。
6. 验证 Cert Spotter 使用 `include_subdomains=true`。
7. 全部 Provider fail + stale cache exists → HTTP 200 + X-Cache: STALE。
8. 全部 Provider fail + 无 stale cache → 统一 502/504。
9. Provider 429 → cooldown + 下一 Provider。
10. Invalid JSON → 下一 Provider。
11. Response too large → Abort + 下一 Provider。
12. 备用 Provider 200/0 results + stale cache 有历史数据 → 返回 stale cache。

## 19. README

架构更新为：

```text
Browser
→ Cloudflare Worker
→ Cloudflare Cache
→ CT Provider Manager
   ├→ crt.sh
   ├→ Cert Spotter
   └→ ctlogs.dev
```

明确说明不同 CT 数据源历史覆盖范围可能不同，因此备用数据源结果数量可能与 crt.sh 不一致。

## 20. Codex 修改原则

开始修改前必须阅读完整仓库、README.md、src/worker.js 和现有测试，理解当前 cache/stale/backoff 机制。

采用 Incremental Changes，不要 Rewrite Entire Project，不要为了架构美观进行无必要的大规模重构。

完成后执行：

```bash
npm test
npm run check
```

确保 Tests Passed 与 Wrangler Dry Run Passed。

## 21. 本阶段不实现

不要实现：

- 多 Provider 并行聚合
- D1/KV/R2
- 用户账户
- 查询历史
- 端口扫描
- 主动扫描
- DNS 暴力枚举
- 资产探测

本阶段只解决 crt.sh 单点故障。

## 22. 最终目标

```text
Fresh Cache
   ↓ MISS
crt.sh
   ↓ FAIL
Cert Spotter
   ↓ FAIL
ctlogs.dev
   ↓ FAIL
Stale Cache
   ↓
Unified Error
```

在不引入数据库、不改变现有 API、不重做 UI 的情况下，显著降低 crt.sh 502 对 crt.foxtang.com 可用性的影响。
