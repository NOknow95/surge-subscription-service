---
name: run-surge-subscription-locally
description: Start, check, or stop this repository's local subscription service with Node.js. Use for local runs, not Docker deployment.
---

# 本机启动订阅代理

从仓库根目录操作，并遵循根目录 `AGENTS.md`。

- 需要 Node.js 22 或更新版本；无需安装 npm 依赖。
- 启动前检查端口 `3080`。如果已有服务在运行，先确认是本项目并复用；若被其他进程占用，不要停止它，可改用其他端口。
- 使用持久终端运行 `node src/server.js`。自定义端口和数据目录：`PORT=3081 DATA_DIR=./data node src/server.js`。
- 用 `curl -fsS -o /dev/null http://127.0.0.1:3080/` 检查首页。健康检查不要请求 `/subscription`，它会拉取上游配置并执行转换脚本。
- 用户要求停止时，只停止本 skill 启动的 Node 进程；优先在对应终端按 `Ctrl-C`。
