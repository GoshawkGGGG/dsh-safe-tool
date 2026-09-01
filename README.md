# dsh-safe-tool

DeepSeek Harness 的 AI 命令审批插件。拦截模型工具调用，通过审核子代理进行安全审查并决定是否执行，审核标准可定制。

**[English Version →](README.en.md)**

## 特性

- **拦截与审批**：挂载 `tools/pre-execute` waterfall，对匹配的工具调用逐个审批
- **纯只读审核员**：子代理仅能调用 `structured_output` 返回决策
- **专属审批预设**：审批子代理继承专属 agent 挂载的预设（默认 `minimal` 极简模式），与主代理预设隔离；预设不存在时自动回退继承主 agent
- **会话记录可清除**：默认（`deleteReviewerSessions: true`）审批结束即删除子代理会话记录，不留审批痕迹；可关闭以保留回溯
- **审核模型自定义**：使用任意 dsh 注册的 provider/model，或继承自父代理（`exec.agent.options.provider/model`）
- **审核工具自定义**：可自定义需要AI审批才能执行的工具
- **AI 回退人工**：AI 解析失败时自动回退人工审批，30 秒未响应则拒绝
- **审核标准热更**：编辑 `$DSH_HOME/dsh-safe-tool/approval-criteria.md` 即时生效，无需重启
- **60 秒缓存**：同一 (会话, 工具, 参数) 60 秒内复用决策，避免重复审批延迟
- **自动放行白名单**：正则匹配参数，已知安全命令直接跳过审批
- **Web UI 设置卡**：在 Settings → Plugins → "AI 工具执行审批" 中可视化配置

---

## 安装

### 从本地源码

```sh
cd dsh-safe-tool
node scripts/build.js                              # 构建
dsh plugin --profile web add ./dsh-safe-tool       # 安装到 web profile
dsh web --profile web                              # 启动 Web UI
```
***注意：默认审批标准可能会影响使用，请根据实际情况自行修改审批标准文件***
源码内路径：docs/approval-criteria.md
安装后路径：~/.dsh/dsh-safe-tool/approval-criteria.md

### 配置

在你的 profile `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: dsh-safe-tool
      name: 'dsh-safe-tool'
      config:
        enabled: true                              # 总开关（默认 true）
        timeoutMs: 30000                           # 单次审核超时(ms)（默认 30000）
        maxTokens: 2048                            # 审核子代理 token 上限（默认 2048）
        filterMode: 'deny-list'                    # 'deny-list' 或 'allow-list'（默认 deny-list）
        tools:                                     # 需要审批的工具列表
          - 'bash'
          - 'write'
        autoAllowPatterns: []                      # 正则白名单，匹配则直接放行（默认空）
        deleteReviewerSessions: true               # 审批后删除子代理会话记录（默认 true）
        reviewerPreset: 'minimal'                  # 审批子代理继承的专属预设（默认 minimal）
```

---

## 配置

### 设置命名空间

插件内部使用 `dsh-safe-tool` 作为 settings 命名空间。
Web UI 中显示为卡片标题 **"AI 工具执行审批"**：

```
Settings → Plugins → "AI 工具执行审批"
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | `boolean` | `true` | 总开关，关闭后插件不拦截任何工具调用 |
| `provider` | `string` | `undefined` | 审核子代理使用的 provider ID，默认继承父代理 |
| `model` | `string` | `undefined` | 审核子代理使用的 model ID，默认继承父代理 |
| `maxTokens` | `number` | `2048` | 审核子代理单次请求的 token 上限（包含 thinking tokens） |
| `timeoutMs` | `number` | `30000` | 单次 AI 审核超时时间（毫秒） |
| `humanTimeoutMs` | `number` | `30000` | AI 回退人工审批的超时时间（毫秒） |
| `filterMode` | `'deny-list' \| 'allow-list'` | `'deny-list'` | 拦截模式：deny-list=拦截列表中工具；allow-list=仅放行列表中工具 |
| `tools` | `string[]` | `['bash', 'write']` | 工具名称列表，根据 filterMode 决定拦截/放行范围 |
| `autoAllowPatterns` | `string[]` | `[]` | 正则表达式列表，匹配工具参数则直接放行，跳过 AI 审批 |
| `deleteReviewerSessions` | `boolean` | `true` | 审批结束后从磁盘删除审批子代理会话记录，不留审批痕迹 |
| `reviewerPreset` | `string` | `'minimal'` | 审批子代理继承的专属 agent 预设 id（默认极简模式）；预设不存在时回退继承主 agent |

### 拦截模式说明

**deny-list（默认）**：仅拦截 `tools` 列表中列出的工具，其他工具直接放行。

```yaml
filterMode: 'deny-list'
tools:
  - 'bash'       # 拦截 bash 工具
  - 'write'      # 拦截 write 工具
  # 其他工具（read, glob 等）直接放行
```

**allow-list**：仅放行 `tools` 列表中列出的工具，其他工具全部拦截。

```yaml
filterMode: 'allow-list'
tools:
  - 'bash'       # 只放行 bash，其他工具全部拦截
```

---

## 审批标准文件

插件从 `$DSH_HOME/dsh-safe-tool/approval-criteria.md` 读取审批标准：

```
$DSH_HOME 解析顺序：
1. 环境变量 DSH_HOME
2. ~/.dsh（即 $HOME/.dsh）
```

**修改标准即时生效**（每次审批实时读取，无需重启）。

### 默认模板

```markdown
## 允许执行
- 只读文件操作：cat, head, tail, grep, find, ls, wc, diff
- 项目构建和测试：npm install, pnpm build, tsc, pnpm test, pnpm dev
- Git 查看操作：git status, git log, git diff（非 push/force push）
- 系统状态查看：ps, docker ps, df, free, top

## 拒绝执行
- 删除操作：rm -rf, rm -r, unlink, truncate
- 高危网络请求：curl POST 含 token/key/password, nc/nmap 端口扫描
- 系统级修改：写入 /etc/, /usr/, /sbin/
- 权限提升：sudo, su, chmod 777, chown root
- 加密货币/挖矿相关命令
- 数据库 DROP/TRUNCATE/DELETE 无 WHERE 条件
- 写入敏感文件：.env, .ssh/, id_rsa, authorized_keys
- 任何包含 base64 编码后疑似恶意负载的命令
- 读取、修改、删除审批标准文件：$DSH_HOME/dsh-safe-tool/approval-criteria.md
```

---

## 工作流程

```
模型调用工具 (如 bash)
        │
        ▼
tools/pre-execute hook
    ├─ 工具不在过滤列表？ → 是 → 直接放行
    ├─ 参数匹配 auto-allow 正则？ → 是 → 直接放行
    ├─ 缓存命中 (同会话/工具/参数 < 60s)？ → 是 → 复用决策
    │
    ▼
启动只读子代理
    ├─ toolFilter: { deny: [所有工具] }          (零执行权限)
    ├─ outputSchema: { approve, reason }          (强制结构化输出)
    ├─ provider/model: 从父代理继承或 config 指定
    └─ prompt: 工具名 + 参数 + 工作目录 + 审批标准
       │
       ▼
解析结果
    ├─ approve=true  → next() → 工具正常执行
    ├─ approve=false → { kind: 'deny', reason } → 模型收到拒绝
    └─ fallback=true → 回退人工审批
       │
       ▼
销毁子代理 (会话立即清理)
```

---

## 安全设计

| 维度 | 措施 |
|------|------|
| 零工具访问 | `toolFilter: { deny: [所有工具] }` —— 审核子代理无法调用任何执行工具 |
| 隔离上下文 | 专属 agent（`minimal` 预设）作为父代理，审核子代理无主会话历史，全新上下文 |
| 结构化输出 | `outputSchema` 强制模型输出 `{approve, reason}`，零自由文本 |
| 会话清除 | 默认删除审批子代理的磁盘会话记录（`deleteReviewerSessions: true`） |
| 超时保护 | `AbortController` + 超时 —— 卡死即拒绝 |
| **Fail-closed** | AI 超时/异常 → 拒绝；AI 解析失败 → 回退人工 → 人工超时 → 拒绝 |
| 输入安全 | 参数经 JSON 序列化注入 prompt，无 Shell 注入风险 |
| 递归防护 | `isPluginReviewer()` 检测审核子代理，放行 `structured_output`，拒绝其他工具 |

---

## 开发

```sh
# 构建插件（自动安装依赖并产出 lib/）
node scripts/build.js

# 类型检查
pnpm run typecheck
```

所有 `@deepseek-ai/*` 依赖均声明在 `package.json` 中，从 npm registry
直接解析。

---

## 许可证

MIT
