# Daily Commit Summarizer

[English](#english) | [中文](#中文)

---

## English

A local CLI tool to generate daily commit summaries using AI. Supports recursive scanning, third-party repo filtering, and offline mode.

### Quick Start

```bash
# Install dependencies
npm install

# Configure (copy and edit .env)
cp .env.example .env

# Run
npx tsx src/index.ts --dir /path/to/projects --recursive
```

### Configuration (.env)

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | `sk-xxx` |
| `OPENAI_BASE_URL` | API endpoint (e.g. `http://localhost:8000/v1`) | `https://api.openai.com/v1` |
| `GIT_OWNERS` | Owner whitelist (comma-separated) | `my-username,my-org` |
| `RUN_MODE` | `online` (AI) or `offline` (git log only) | `online` |

### Compatible APIs

Supports any OpenAI-compatible API (e.g. vLLM, Ollama, DeepSeek). Set `OPENAI_BASE_URL` to your endpoint (usually ending in `/v1`).
| `PROMPTS_FILE` | Custom prompts file path | `prompts.json` |
| `REPORT_FILENAME_FORMAT` | Report filename template | `{{date}}_{{repo}}.md` |

### Filename Template Variables

- `{{date}}` - Date (YYYY-MM-DD)
- `{{year}}` - Year (YYYY)
- `{{month}}` - Month (MM)
- `{{repo}}` - Repository name
- `{{owner}}` - Repository owner (from remote URL)
- `{{author}}` - Commit author (first of the day)

### Usage

```bash
# Scan all repos in a directory (recursive)
npx tsx src/index.ts --dir /path/to/projects --recursive

# Analyze specific repo
npx tsx src/index.ts --repo /path/to/repo

# Look back N days
npx tsx src/index.ts --dir /path --recursive --days 3

# Since a specific date
npx tsx src/index.ts --dir /path --recursive --since 2025-01-01

# Offline mode (skip AI, use commit titles)
npx tsx src/index.ts --dir /path --recursive --mode offline

# Specify owners via CLI
npx tsx src/index.ts --dir /path --recursive --owners my-username,my-org
```

### Features

- ✅ **Recursive Scanning** - Discover repos in nested directories
- ✅ **Owner Whitelist** - Auto-skip third-party repos based on remote URL
- ✅ **Multi-Platform** - Supports GitHub, GitLab, Gitee, Bitbucket URLs
- ✅ **Offline Mode** - Generate reports without AI
- ✅ **Caching** - Resume interrupted runs, skip processed commits
- ✅ **Real-time Output** - Markdown reports generated incrementally

---

## 中文

本地 CLI 工具，使用 AI 生成每日 Git 提交摘要。支持递归扫描、第三方仓库过滤和离线模式。

### 快速开始

```bash
# 安装依赖
npm install

# 配置（复制并编辑 .env）
cp .env.example .env

# 运行
npx tsx src/index.ts --dir /path/to/projects --recursive
```

### 配置说明 (.env)

| 变量 | 说明 | 示例 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | `sk-xxx` |
| `OPENAI_BASE_URL` | API 端点地址 | `https://api.openai.com` |
| `GIT_OWNERS` | 仓库 Owner 白名单（逗号分隔） | `my-username,my-org` |
| `RUN_MODE` | `online`（使用 AI）或 `offline`（仅 git log） | `online` |
| `PROMPTS_FILE` | 自定义 Prompt 模板文件路径 | `prompts.json` |
| `REPORT_FILENAME_FORMAT` | 报告文件名以模版格式 | `{{date}}_{{repo}}.md` |

### 文件名模版变量

支持以下变量：
- `{{date}}` - 日期 (YYYY-MM-DD)
- `{{year}}` - 年 (YYYY)
- `{{month}}` - 月 (MM)
- `{{repo}}` - 仓库名
- `{{owner}}` - 仓库 owner (基于 remote URL)
- `{{author}}` - 提交作者 (当日首个)

### 使用方法

```bash
# 递归扫描目录下所有仓库
npx tsx src/index.ts --dir /path/to/projects --recursive

# 分析单个仓库
npx tsx src/index.ts --repo /path/to/repo

# 回溯 N 天
npx tsx src/index.ts --dir /path --recursive --days 3

# 从指定日期开始
npx tsx src/index.ts --dir /path --recursive --since 2025-01-01

# 离线模式（跳过 AI，使用 commit 标题）
npx tsx src/index.ts --dir /path --recursive --mode offline

# 命令行指定 owners
npx tsx src/index.ts --dir /path --recursive --owners my-username,my-org
```

### 功能特性

- ✅ **递归扫描** - 发现嵌套目录中的仓库
- ✅ **Owner 白名单** - 根据 remote URL 自动跳过第三方仓库
- ✅ **多平台支持** - 支持 GitHub、GitLab、Gitee、Bitbucket
- ✅ **离线模式** - 无需 AI 即可生成报告
- ✅ **断点续传** - 缓存已处理的提交，支持中断恢复
- ✅ **实时输出** - Markdown 报告增量生成

---

## License

MIT
