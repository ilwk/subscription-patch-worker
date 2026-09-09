# Subscription Patch Worker

用 TypeScript 编写的订阅配置合并工具，部署在 Cloudflare Workers 上，将自定义配置项合并到上游订阅，并提供可自动更新的订阅地址。
当前支持 sing-box JSON 和 Clash/Mihomo YAML、JSON；自动识别配置结构，保留节点及其他字段的值。
它不会把 sing-box 转成 Clash，也不解析 Base64 节点列表。

## 配置合并

| 格式 | 修改字段 |
| --- | --- |
| sing-box | 所有 TUN 入站的 `route_exclude_address` |
| Mihomo | 顶层 `tun.route-exclude-address` |

默认合并 `10.0.0.0/8` 并去重。Mihomo 没有 tun 时只补充配置选项，不设置 enable。
sing-box 没有 TUN 时返回 502。Clash 指支持此字段的 Mihomo 内核，旧 Clash 不保证兼容。
YAML 会重新序列化，注释、缩进、锚点表现形式不保留；字段值保留。
只处理 Mihomo 顶层 TUN，不处理高级 listeners TUN。

## 从 GitHub 部署（推荐）

1. 将仓库导入 Cloudflare Workers & Pages，连接 GitHub 仓库。
2. Worker 名称设为 `subscription-patch-worker`，生产分支 `main`，根目录为仓库根目录。
3. 构建命令填 `npm ci && npm run check`，部署命令填 `npx wrangler deploy`。
4. 在 Worker 的 Settings → Variables and Secrets 中添加以下 **Secret**，保存部署：
   - `UPSTREAM_URL`：机场原始 HTTPS 订阅地址，必须返回完整配置。
   - `ACCESS_TOKEN`：下游访问密钥，建议使用随机生成的 32 字节十六进制字符串。
5. 此后推送 main 会自动重新部署代码，Secret 留在 Cloudflare，不写入 GitHub。

首次未配置 Secret 时 /config 返回 503，这是预期行为。/health 只检查 Worker 可访问。
Workers Builds 的变量与运行时 Secret 有区别：这些 Secret 必须配在运行时 Variables and Secrets。
仓库的 GitHub Actions 负责类型检查、测试和打包；生产部署由 Cloudflare Git 集成负责。
如果修改 wrangler.jsonc 中的名称，需要同步 Cloudflare Worker 名称。

## 客户端订阅地址

在客户端中添加远程订阅，填写（示意值）：

```text
https://subscription-patch-worker.ACCOUNT.workers.dev/config?token=YOUR_ACCESS_TOKEN
```

将 YOUR_ACCESS_TOKEN 替换为 Secret 中设置的密钥；特殊字符需要 URL 编码。
无需额外认证请求头。完整链接包含访问凭据，请勿公开或粘贴到公共日志。
Worker 不记录请求 URL，也不将下游 token 转发给上游；外部访问日志仍应避免保存完整查询参数。
原订阅使用特定 User-Agent 选择格式时，默认透传客户端 User-Agent。
可添加普通变量 `UPSTREAM_USER_AGENT` 固定它；单个 Worker 只配置一个上游，
不同格式有不同上游 URL 时可部署多个 Worker。

## 自定义与更新

`wrangler.jsonc` 的 `EXCLUDE_CIDRS` 是逗号分隔的 IPv4/IPv6 CIDR。
例如 `10.0.0.0/8,172.16.0.0/12`。现有排除项保留；修改、提交、推送后自动部署。

`src/adapters.ts` 管理格式识别与补丁，`src/index.ts` 管理鉴权和上游请求。
当前仅实现 TUN 网段排除；以后新增域名规则或 DNS 补丁可在适配器内扩展。

## 本地开发或 CLI 部署

使用 Node.js 24：

```powershell
npm ci
npm run check
npm run build
npx wrangler login
npm run deploy
npx wrangler secret put UPSTREAM_URL
npx wrangler secret put ACCESS_TOKEN
```

本地开发可创建被 Git 忽略的 `.dev.vars`，填入这两个变量，然后 `npm run dev`。
没有真实凭据的测试使用模拟订阅，不会请求机场。
`npm run build` 仅打包检查，不发布。

## 请求行为

- GET /config 需要单个有效的 token 参数；GET /health 返回 ok。
- 所有响应禁止缓存，下游凭据不转发给机场。
- 上游请求与读取设有 20 秒超时、5 MiB 流式大小限制。
- 上游必须 HTTPS；跳转直接报错，请使用跳转后的最终订阅地址。
- 出错返回通用 502，不记录可能包含凭据的异常或返回上游错误正文。
- 只验证补丁所需结构，不替代 sing-box/Mihomo 内核的完整配置检查。
- 不使用 KV/R2，也不缓存旧订阅；上游故障期间更新失败。
- Cloudflare 作为执行服务会接触订阅内容，请保护 Worker Secret 和下游地址。

## 后续规划

多订阅地址聚合、节点去重、名称冲突处理及分组引用更新。当前版本使用单个上游地址。

参考：[Cloudflare GitHub 集成](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)、
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、
[Mihomo TUN](https://wiki.metacubex.one/en/config/inbound/tun/)。
