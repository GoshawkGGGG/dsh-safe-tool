# AI 命令执行审批标准

## 允许执行

以下类型的命令通常可以安全执行：

### 只读文件操作
- `cat`, `head`, `tail`, `wc`, `less`, `more`
- `grep`, `rg`, `find`, `ls`, `stat`
- `diff`, `md5sum`, `sha256sum`

### 项目构建和测试
- `npm install`, `pnpm install`, `yarn install`
- `npm run build`, `pnpm build`, `tsc`
- `npm test`, `pnpm test`, `jest`, `vitest`
- `npm run dev`, `pnpm dev`

### Git 查看操作
- `git status`, `git log`, `git diff`, `git show`
- `git branch`, `git tag`

### 系统状态查看
- `ps`, `top`, `htop`, `docker ps`
- `df`, `free`, `uptime`, `uname`
- `curl` GET 请求（不含敏感 header）

---

## 拒绝执行

以下类型的命令存在安全风险，应被拒绝：

### 删除操作
- `rm -rf`, `rm -r`, `rm --recursive`
- `unlink`, `truncate`, `hollow`
- 任何删除目录或大量文件的命令

### 高危网络请求
- `curl` POST/PUT 含 `token`, `key`, `password`, `secret` 参数
- `nc`, `netcat`, `nmap` 端口扫描
- 连接到非预期域名的请求

### 系统级修改
- 写入 `/etc/`, `/usr/`, `/sbin/`, `/bin/`
- `apt install`, `yum install`, `pacman -S`（包管理器）
- 修改系统服务配置

### 权限提升
- `sudo`, `su`, `chmod 777`, `chown root`
- 任何涉及特权提升的命令

### 加密货币/挖矿
- 任何包含 `mining`, `coinbase`, `stratum` 关键字的命令

### 数据库危险操作
- `DROP DATABASE`, `DROP TABLE`
- `TRUNCATE TABLE`
- `DELETE` 无 `WHERE` 条件的 SQL

### 敏感文件写入
- 写入 `.env`, `.env.local`
- 写入 `~/.ssh/`, `id_rsa`, `authorized_keys`
- 写入 `~/.config/` 中的认证相关文件

---

## 审查原则

1. **安全第一**：宁可误判拒绝，也不放过高风险命令
2. **上下文感知**：CI 环境（有 `CI=true` 环境变量）可适当放宽构建类操作
3. **未知工具审慎**：无法确认用途的工具调用默认拒绝
4. **描述缺失则拒绝**：tool description 为空时要求补充说明
