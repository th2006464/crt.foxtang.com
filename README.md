# crt.foxtang.com

轻量级 Certificate Transparency 查询工具，用于整理 crt.sh 公开日志中的证书、历史域名和子域名记录。界面延续 `ip.foxtang.com` 的轻量工具风格。

## Architecture

```text
Browser
→ Cloudflare Worker
→ Cloudflare Cache
→ CT Provider Manager
   ├→ crt.sh
   ├→ Cert Spotter
   └→ ctlogs.dev
```

- No D1
- No KV
- No persistent query database
- 应用层不保存查询历史或用户 IP

## 功能

- 支持域名、完整 URL 和 `?q=example.com` 分享链接
- 域名标准化、输入验证与固定 crt.sh 上游，避免 SSRF
- 证书与 SAN 清洗、去重、排序、状态判断
- Wildcard 标识、域名筛选、复制反馈、证书详情
- Cloudflare Cache API：默认新鲜 TTL 6 小时；上游不可用时可回退最多 7 天的近期缓存，响应头显示 `X-Cache: HIT/MISS/STALE`
- 顺序故障切换：crt.sh（8 秒）→ Cert Spotter（6 秒）→ ctlogs.dev（6 秒）；每个来源独立冷却
- 单个上游响应 10 MiB 上限与统一错误响应
- 响应式布局和键盘、ARIA、reduced-motion 支持

## 本地开发

要求 Node.js 20+。

```bash
npm install
npm run dev
```

访问 Wrangler 输出的本地地址。查询接口为：

```text
GET /api/search?domain=example.com
```

## 配置

非敏感变量在 `wrangler.jsonc` 中配置：

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `CACHE_TTL` | `21600` | Cloudflare 边缘缓存秒数 |
| `STALE_CACHE_TTL` | `604800` | 上游异常时可回退的缓存最长秒数 |
| `UPSTREAM_BACKOFF_TTL` | `90` | 单个数据源失败后的短暂冷却秒数，避免重复请求故障来源 |

本项目没有密钥或必需的环境变量。

## 测试与部署预检

```bash
npm test
npm run check
```

`npm run check` 会执行 Wrangler dry-run 和单元测试。

## 部署到 Cloudflare Workers

```bash
npx wrangler login
npm run deploy
```

部署后，在 Cloudflare Dashboard 为 Worker 添加 Custom Domain：

```text
crt.foxtang.com
```

建议另行配置 Cloudflare Rate Limiting Rule：对 `/api/search*` 按单 IP 限制约 30 次/分钟。项目不使用数据库记录 IP。

## 已知限制

- 不同 CT 数据源的历史覆盖范围可能不同，因此备用数据源结果数量可能与 crt.sh 不一致。发生异常时，站点会优先返回近期缓存结果，并明确标注“缓存回退”。
- Cloudflare Cache API 按数据中心缓存，不会自动跨 POP 复制，也不作为持久化存储。
- 单次上游响应限制为 10 MiB；超大查询会返回统一错误。
- CT 历史记录不代表域名当前存在、可访问或仍归当前持有人所有。

## 安全与隐私

- 上游主机硬编码为 `crt.sh`，用户输入只能作为已验证域名查询参数。
- API 仅允许 GET，包含安全响应头、CSP 和统一错误消息。
- 不启用 D1、KV、R2、Durable Objects 或任何查询历史数据库。
- Cloudflare 平台可能保留正常运行日志或分析数据，因此不宣称“完全无日志”。
