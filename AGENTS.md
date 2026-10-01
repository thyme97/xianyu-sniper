# AGENTS.md — AI 协作与项目规范

本文件约束 AI 助手在本仓库内的行为。每次会话开始处理本项目的任务前，应先阅读本文档与 `docs/03-里程碑与进度.md`。

## 1. 项目一句话

本地优先的闲鱼蹲价监控工具：关键词 + 目标价 → 定时扫描 → 规则+AI 双层筛选 → 多渠道通知。Node.js 20+ / Playwright / better-sqlite3 / Fastify。

## 2. 技术约定

- 语言与运行时：JavaScript（Node.js 20+），ESM（`"type": "module"`）。
- 采集：Playwright。登录用有头模式（`npm run login`），日常扫描用 headless，登录态持久化到 `state/storage_state.json`。
- 采集方式：**监听闲鱼搜索接口的响应**，不解析页面 DOM。解析逻辑参考 `reference/xianyu-supply-monitor/xianyu-parser.js` 移植。
- 存储：better-sqlite3，单文件 `data/app.db`。表结构与迁移脚本见 `docs/02-架构设计.md`。
- Web：Fastify + `@fastify/static` 托管静态页，REST API 前缀 `/api`。
- 通知：每个渠道一个独立模块，统一实现 `notify(item) { Promise<void> }` 接口，由 `src/notify/index.js` 注册分发。
- AI：OpenAI 兼容 Chat Completions 接口，可全局/按任务关闭；输入标题+描述+价格，输出严格 JSON `{match, reason}`。
- 配置：`config.json`（gitignore）从 `config.example.json` 复制；敏感信息（AI Key、推送 Key）一律不入库不入 git。

## 3. 编码规范

- 注释与文档一律使用中文；标识符用英文。
- 不做过度设计：不为假设需求添加抽象层；每个模块保持单一职责。
- 错误处理：采集与通知属边界层，需捕获并写入 `scan_log`，不让单次失败中断调度循环。
- 防封基线：轮询间隔 ≥60 秒且带随机抖动；多关键词错峰；禁止并发轰炸同一接口。
- 每次改动 JS 文件后运行语法检查：`node --check <file>`。

## 4. 文档留存规则（重要）

- 文档全部集中在 `docs/`，按 `01/02/03/04` 编号命名，编号固定不重排；新增文档接续编号。
- **进度唯一事实来源是 `docs/03-里程碑与进度.md`**：每完成一项任务、做出一个方案变更，必须当次更新该文件的「任务清单」勾选状态，并在「进度日志」表追加一行（日期 | 变更内容 | 备注）。
- 方案/架构层面的决策变更（技术选型、数据模型、流程），除更新进度日志外，必须同步修改 `docs/01` 或 `docs/02` 对应章节，保持文档与代码一致。
- `reference/` 中的代码是 Xianyu-Supply-Monitor 的留存快照（原目录后续会删除），只读参考，禁止直接修改；移植时拷贝到 `src/` 内改造。
- 禁止提交：`state/`、`data/`、`config.json`、`node_modules/`、`logs/`。

## 5. 当前状态速览

- 阶段：文档完成，骨架已搭建，M1 尚未开始编码。
- 下一步：见 `docs/03-里程碑与进度.md` 的 M1 任务清单。
