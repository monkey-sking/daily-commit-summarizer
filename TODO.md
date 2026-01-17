# Daily Commit Summarizer - TODO

## ✅ 已完成

### 配置增强

- [x] **Prompt 可配置** (`PROMPTS_FILE`) - 自定义 AI 提示词模板
- [x] **文件名格式配置** (`REPORT_FILENAME_FORMAT`) - 自定义生成的日报文件名
  - 支持变量: `{{date}}`, `{{year}}`, `{{month}}`, `{{repo}}`, `{{owner}}`, `{{author}}`
- [x] **运行模式配置** (`RUN_MODE`) - Online/Offline

### 核心功能

- [x] 递归扫描 (`--recursive`)
- [x] 基于 URL 的 Owner 过滤
- [x] 多平台支持

---

## 🟡 中优先级

### 多平台支持增强

- [ ] GitLab CI/CD 集成
- [ ] Gitee Webhook 集成
- [ ] 自建 Git 服务器 URL 模式配置

---

## 🟢 低优先级 / 未来增强

- [ ] 支持 `.commit-summarizer.json` 项目配置文件
- [ ] 按项目自定义过滤规则
- [ ] HTML 格式输出
