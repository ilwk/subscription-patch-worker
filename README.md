# Subscription Patch Worker

用 TypeScript 编写的订阅配置合并工具，部署在 Cloudflare Workers。
拉取上游订阅后，自动识别 sing-box 或 Clash/Mihomo，应用独立维护的覆盖文件，再输出订阅。

## 覆盖文件

- [overrides/sing-box.json](overrides/sing-box.json)：sing-box 配置，JSON 格式。
- [overrides/mihomo.yaml](overrides/mihomo.yaml)：Clash/Mihomo 配置，YAML 格式。

两份文件默认均为 `{}`，不会添加任何默认配置。只需编辑对应文件、提交并推送，自动部署后重新更新客户端订阅即可。
Mihomo 文件也可以留空或只写注释，表示不覆盖。

### 合并规则

| 内容                               | 行为                                |
| ---------------------------------- | ----------------------------------- |
| 对象                               | 递归合并，未指定的字段保留          |
| 普通数组                           | 整体替换，顺序按覆盖文件            |
| 标量、null                         | 替换原值；null 不表示删除           |
| sing-box 顶层 inbounds / outbounds | 按 tag 匹配并递归合并，未匹配项追加 |
| 空数组 []                          | 清空对应数组                        |
| 空覆盖对象 {}                      | 原样返回上游文本                    |

sing-box 入站、出站的覆盖项必须有唯一且非空的 tag；新增项还必须带 type。
未匹配的上游条目保留，原顺序保留，新增项排在末尾。请准确填写上游 tag。
此特殊规则只应用于顶层 inbounds/outbounds，其内部数组仍整体替换。
Clash 的 proxies、proxy-groups、rules 等数组也整体替换。

### sing-box 示例

修改指定入站的 MTU，并调整日志级别：

```json
{
  "log": { "level": "warn" },
  "inbounds": [{ "tag": "tun-in", "mtu": 1500 }]
}
```

### Mihomo 示例

```yaml
log-level: warning
tun:
  mtu: 1500
dns:
  nameserver:
    - https://1.1.1.1/dns-query
```

示例不默认启用。覆盖规则数组时应写出完整规则列表，而不是只写新增规则。

## 从 GitHub 部署

1. 在 Cloudflare Workers & Pages 连接本仓库，Worker 名称为 `subscription-patch-worker`，分支 main，根目录为仓库根目录。
2. 使用 Node.js 24、pnpm 11.22.0（package.json 已固定 packageManager）。
3. 构建命令：`pnpm install --frozen-lockfile && pnpm check`。
4. 部署命令：`pnpm exec wrangler deploy`。
5. 在 Worker 运行时 Settings → Variables and Secrets 添加两个 Secret：
   - `UPSTREAM_URL`：返回完整配置的 HTTPS 订阅地址。
   - `ACCESS_TOKEN`：随机长密钥，建议随机生成 32 字节十六进制字符串。

GitHub Actions 检查类型、合并行为并打包；Cloudflare Git 集成负责自动部署。
首次还没设置 Secret 时，/config 返回 503；设置后即可使用。

已经部署旧版本的用户，请同步修改 Cloudflare 中原来的 npm 构建、部署命令。
旧的 EXCLUDE_CIDRS 已从代码和部署配置移除；后台若还有残留可以删除，代码不会读取它。
两个覆盖文件现在默认不覆盖；需要的配置应明确写进文件。

## 客户端订阅地址

```text
https://subscription-patch-worker.ACCOUNT.workers.dev/config?token=YOUR_ACCESS_TOKEN
```

替换域名和 token 即可，无需自定义请求头。特殊字符需要 URL 编码。
完整链接含访问凭据，请勿公开。Worker 不记录请求 URL 或上游错误，外部日志也应避免保存完整查询参数。

默认透传客户端 User-Agent。可选的 UPSTREAM_USER_AGENT 可固定上游请求标识。
当前每个 Worker 使用一个上游地址；上游需要按客户端返回相应格式，本工具不进行跨格式转换。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm build` 只执行 Wrangler dry-run，不发布。测试用 esbuild 加载 TypeScript、JSON 和 YAML 后交给 Node 测试器运行。
本地开发可在被 Git 忽略的 `.dev.vars` 中配置两个 Secret，然后执行 `pnpm dev`。

CLI 部署：

```sh
pnpm exec wrangler login
pnpm deploy
pnpm exec wrangler secret put UPSTREAM_URL
pnpm exec wrangler secret put ACCESS_TOKEN
```

代码结构：

- src/index.ts：鉴权、请求和响应。
- src/adapters.ts：格式识别、解析及序列化。
- src/merge.ts：递归合并和按 tag 合并。

## 边界

- sing-box 使用 JSON；Mihomo 支持 YAML 或 JSON，输出保留输入格式。
- 空覆盖原样透传；非空覆盖会重新序列化，文本格式与 YAML 注释、锚点表现形式不保留。
- 未知或混合格式拒绝处理，不支持 Base64 节点列表。
- 仅验证合并所需结构，不替代代理内核的完整配置检查。
- 请求设有 20 秒超时和 5 MiB 流式大小限制；上游必须 HTTPS，不跟随跳转。
- 响应禁止缓存，token 不传给上游；上游失败时返回通用 502，不存储旧订阅。
- 原型相关危险键拒绝合并，YAML 禁止重复键并限制别名展开。

## 后续规划

多订阅地址聚合、节点去重、名称冲突处理及分组引用更新。当前未实现多订阅聚合。

参考：[Cloudflare GitHub 集成](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)、
[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。
