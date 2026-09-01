# dsh-safe-tool

AI-powered command approval plugin for DeepSeek Harness. Intercepts model tool calls and routes them through a read-only review subagent before execution.

**[中文版](README.md)**

## Features

- **Intercept & Review**: Hook into `tools/pre-execute` waterfall to review every matching tool call
- **Read-Only Reviewer**: Subagent has zero tool permissions (`toolFilter: { deny: [all tools] }`) — only calls `structured_output` to return decisions
- **Dedicated Reviewer Preset**: Review subagent inherits a dedicated parent agent's preset (default `minimal`), isolated from the main agent's preset; falls back to the main agent when the preset is unknown
- **Session Cleanup**: By default (`deleteReviewerSessions: true`) the review subagent's session is deleted from disk after settlement; disable to keep it for audit
- **Configurable Model**: Use any dsh-registered provider/model, or inherit from parent agent (`exec.agent.options.provider/model`)
- **AI-to-Human Fallback**: AI parse failures fall back to human approval, denied after 30s timeout
- **Live Criteria Updates**: Edit `/root/.dsh/dsh-safe-tool/approval-criteria.md` for instant effect — no restart needed
- **60s Cache**: Same (session, tool, args) within 60s reuses decision — no repeated review latency
- **Auto-Allow Patterns**: Regex whitelist to bypass review for known-safe commands
- **Web UI Settings Card**: Configure via Settings → Plugins → "AI Tool Approval"

---

## Installation

### From local source

```sh
cd dsh-safe-tool
node scripts/build.js                              # Build
dsh plugin --profile web add ./dsh-safe-tool       # Install to web profile
dsh web --profile web                              # Start Web UI
```

### Manual patch

Add to your profile `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-safe-tool
      name: 'dsh-safe-tool'
      config:
        enabled: true                              # Master switch (default: true)
        timeoutMs: 30000                           # Single review timeout in ms (default: 30000)
        maxTokens: 2048                            # Review subagent token limit (default: 2048)
        filterMode: 'deny-list'                    # 'deny-list' or 'allow-list' (default: deny-list)
        tools:                                     # Tools to review
          - 'bash'
          - 'write'
        autoAllowPatterns: []                      # Regex whitelist to bypass review (default: empty)
        deleteReviewerSessions: true               # Delete reviewer session records after review (default: true)
        reviewerPreset: 'minimal'                  # Preset the review subagent inherits (default: minimal)
```

---

## Configuration

### Settings Namespace

The plugin uses `dsh-safe-tool` as the internal settings namespace (for programmatic access).
In the Web UI it appears as the card title **"AI Tool Approval"**:

```
Settings → Plugins → "AI Tool Approval"
```

Or set programmatically:

```typescript
ctx.get('settings')?.replace('dsh-safe-tool', {
  enabled: true,
  timeoutMs: 30000,
  maxTokens: 2048,
  filterMode: 'deny-list',
  tools: ['bash', 'write'],
  autoAllowPatterns: [],
  deleteReviewerSessions: true,
  reviewerPreset: 'minimal',
})
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Master switch; when false, plugin does not intercept any tool calls |
| `provider` | `string` | `undefined` | Provider ID for review subagent; inherits from parent by default |
| `model` | `string` | `undefined` | Model ID for review subagent; inherits from parent by default |
| `maxTokens` | `number` | `2048` | Token limit per review subagent request (includes thinking tokens) |
| `timeoutMs` | `number` | `30000` | Timeout for single AI review in milliseconds |
| `humanTimeoutMs` | `number` | `30000` | Timeout for human approval fallback in milliseconds |
| `filterMode` | `'deny-list' | 'allow-list'` | `'deny-list'` | Filter mode: deny-list blocks listed tools; allow-list only permits listed tools |
| `tools` | `string[]` | `['bash', 'write']` | Tool name list; determines scope based on filterMode |
| `autoAllowPatterns` | `string[]` | `[]` | Regex patterns; match tool args to bypass review |
| `deleteReviewerSessions` | `boolean` | `true` | Delete the review subagent's session records from disk after review |
| `reviewerPreset` | `string` | `'minimal'` | Preset id the review subagent inherits via its dedicated parent (default: minimal); falls back to the main agent if unknown |

### Filter Mode Explanation

**deny-list (default)**: Only intercept tools listed in `tools`; others pass through.

```yaml
filterMode: 'deny-list'
tools:
  - 'bash'       # Intercept bash tool
  - 'write'      # Intercept write tool
  # Other tools (read, glob, etc.) pass through
```

**allow-list**: Only permit tools listed in `tools`; all others are intercepted.

```yaml
filterMode: 'allow-list'
tools:
  - 'bash'       # Only allow bash; all other tools intercepted
```

---

## Approval Criteria File

The plugin reads approval criteria from `/root/.dsh/dsh-safe-tool/approval-criteria.md`:

```
/root/.dsh resolution order:
1. DSH_HOME environment variable
2. ~/.dsh (i.e., $HOME/.dsh)
```

**Changes take effect immediately** (file is read on every review, no restart needed).

### Default Template

```markdown
## Allowed
- Read operations: cat, head, tail, grep, find, ls, wc, diff
- Build and test: npm install, pnpm build, tsc, pnpm test, pnpm dev
- Git view operations: git status, git log, git diff (non-push/force push)
- System status: ps, docker ps, df, free, top

## Denied
- Deletion: rm -rf, rm -r, unlink, truncate
- High-risk network: curl POST with token/key/password, nc/nmap port scanning
- System modifications: writing to /etc/, /usr/, /sbin/
- Privilege escalation: sudo, su, chmod 777, chown root
- Cryptocurrency/mining commands
- Database DROP/TRUNCATE/DELETE without WHERE clause
- Sensitive files: .env, .ssh/, id_rsa, authorized_keys
- Commands with base64-encoded suspicious payloads
- Read/modify/delete approval criteria: $DSH_HOME/dsh-safe-tool/approval-criteria.md
```

---

## Workflow

```
Model calls tool (e.g., bash)
        |
        v
tools/pre-execute hook
    |-- Tool not in filter list? -> Yes -> Allow
    |-- Args match auto-allow regex? -> Yes -> Allow
    |-- Cache hit (same session/tool/args < 60s)? -> Yes -> Reuse decision
    |
    v
Start read-only subagent
    |-- toolFilter: { deny: [all tools] }          (zero execution permissions)
    |-- outputSchema: { approve, reason }           (forced structured output)
    |-- provider/model: inherited from parent or config
    -- prompt: tool name + args + cwd + criteria
       |
       v
Parse result
    |-- approve=true  -> next() -> Tool executes normally
    |-- approve=false -> { kind: 'deny', reason } -> Model receives denial
    -- fallback=true -> Human approval fallback
       |
       v
Dispose subagent (session cleanup)
```

---

## Security Design

| Aspect | Measure |
|--------|---------|
| Zero tool access | `toolFilter: { deny: [all tools] }` — reviewer cannot call any execution tools |
| Isolated context | Dedicated parent agent (`minimal` preset): reviewer has no main-session history, fresh context |
| Structured output | `outputSchema` forces `{approve, reason}` output — zero free text |
| Session cleanup | Deletes the review subagent's disk records by default (`deleteReviewerSessions: true`) |
| Timeout protection | `AbortController` + timeout — hang means denial |
| **Fail-closed** | AI timeout/error -> deny; AI parse failure -> human fallback -> human timeout -> deny |
| Input safety | Args serialized to JSON for prompt injection — no Shell injection risk |
| Recursion guard | `isPluginReviewer()` detects reviewer subagents, allows `structured_output`, denies others |

---

## Development

```sh
# Build plugin (installs dependencies and produces lib/)
node scripts/build.js

# Type check
pnpm run typecheck
```

All `@deepseek-ai/*` dependencies are declared in `package.json` and resolved
from the npm registry directly.

---

## License

MIT
