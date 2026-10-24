# CLAUDE.md

## Rules

- After every change, create a corresponding git commit to track changes for future rollback.
- After every change, write or update relevant tests. Before delivering to the user, ensure all modified parts' tests and verification pass.

## Git Commit & PR Attribution

- End all git commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- End pull request descriptions with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

## Development Process

新功能 / 较大修复按 [docs/dev-process.md](docs/dev-process.md) 执行：
需求 → 设计 spec → **对抗审查** → 实现计划 → **计划对抗审查** → TDD 实现 → **代码审查** →
全量验证 → 推送/部署。开工前先读该文档；审查由开发方独立对抗完成，不推给用户。
