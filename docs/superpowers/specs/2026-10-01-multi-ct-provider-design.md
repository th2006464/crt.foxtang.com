# 多 CT 数据源容灾设计

## 目标

在不改变 `GET /api/search?domain=example.com`、不引入持久化存储、且不重做界面的前提下，消除 crt.sh 单点故障：缓存未命中时，依次使用 crt.sh、Cert Spotter、ctlogs.dev；全部失败后回退至最多 7 天的陈旧缓存。

## 范围与约束

- 保持 Cloudflare Workers、Cloudflare Cache API 和现有缓存键：`/__cache/cert/{domain}` 与 `__cache/cert-stale/{domain}`。
- 保持 `CACHE_TTL=21600`、`STALE_CACHE_TTL=604800`；不使用 D1、KV、R2、Durable Objects 或任何查询历史数据库。
- Provider Origin 均为代码中的固定地址，用户输入不能影响上游主机。
- 不并行请求或聚合三个 Provider；不实现登录、扫描、枚举或查询历史。

## Provider 链

```text
Fresh Cache HIT → 直接返回
Fresh Cache MISS → crt.sh → Cert Spotter → ctlogs.dev → Stale Cache → 统一错误
```

Provider 按顺序执行。crt.sh 使用现有 `q=%.{domain}&output=json` 查询，超时 8 秒；Cert Spotter 使用根域名和 `include_subdomains=true`，超时 6 秒；ctlogs.dev 使用 `/v1/subdomains/{domain}`，超时 6 秒。网络错误、超时、429、5xx、无效 JSON、响应超过 10 MiB 或不符合预期的主体，均视为本 Provider 失败并继续下一个。

每个 Provider 使用独立的 Cloudflare Cache 冷却键（`/__cache/provider-backoff/{provider-id}`）。冷却期间跳过该 Provider；429 和失败均写入对应短期冷却项。链路总时长应接近但不超过三项超时的总和。

## 数据标准化

每个 Provider 负责“请求”与“转换原始响应”两项工作，Provider Manager 只处理顺序、失败及统一响应。转换输出均遵守既有前端模型：`success`、`domain`、`source`、`queryTime`、`count`、`domains` 与 `certificates`。

所有 hostname 统一转小写并移除尾部点号；只保留根域名自身或以 `.{domain}` 结尾的名称。合法的 `*.{domain}` 保留。使用 Set 去重，并沿用现有按层级、字母和 wildcard 的排序体验。

Cert Spotter 优先从 `dns_names` 产生域名；无法可靠提供的 issuer、serial、起止日期可为空，不能为了补全而增加额外请求。ctlogs.dev 以 subdomains endpoint 的结果产生子域名；它不是历史完整替代源，因此结果数量可能少于 crt.sh。

## 缓存、空结果与响应

任一 Provider 的成功标准化结果覆盖同一份 fresh/stale 缓存，不按 Provider 拆分缓存键。fresh 命中响应带 `X-Cache: HIT`；查询完成响应带 `X-Cache: MISS`；陈旧回退带 `X-Cache: STALE`、`X-Data-Freshness: stale` 与 `Cache-Control: no-store`。

新增 `X-CT-Source`，值为 `crt.sh`、`certspotter` 或 `ctlogs.dev`。陈旧缓存保留其缓存数据的来源，前端显示为“数据来源：{来源} · 缓存数据”。普通用户只看到统一的可重试错误，不暴露 429、502 等 Provider 内部细节。

HTTP 200 的空结果并非 Provider 失败：若无 stale 数据，缓存并返回空结果；若 stale 数据已有至少一个历史域名或证书，则优先返回 stale，防止覆盖范围较小的备用源误导用户。全部 Provider 失败时，有 stale 返回 200；无 stale 返回统一 502 或 504。

## 代码边界

- `src/worker.js`：保留域名验证、缓存和路由；新增 Provider 请求函数、规范化函数、统一的有限大小 JSON 读取以及 Provider Manager。
- `test/worker.test.js`：以可控的 `fetch` 与 Cache mock 验证调用顺序、URL、缓存、冷却和响应头。
- `public/app.js`：基于 `X-CT-Source` 或响应 `source` 显示轻量来源文案，不改变现有页面结构。
- `README.md`：更新架构图、Provider 说明、缓存/冷却配置和历史覆盖范围限制。

## 验收标准

- crt.sh 成功时不调用备用源；crt.sh 错误或超时时自动切到 Cert Spotter；前两者失败时切到 ctlogs.dev。
- Cert Spotter 请求包含 `include_subdomains=true`；ctlogs.dev 请求为 `/v1/subdomains/{domain}`。
- 429、无效 JSON、超大响应及异常响应格式会冷却对应 Provider 并继续下一源。
- 所有 Provider 失败时正确使用 stale；备用源空结果不会覆盖既有非空 stale 数据。
- `npm test` 和 `npm run check` 均通过。
