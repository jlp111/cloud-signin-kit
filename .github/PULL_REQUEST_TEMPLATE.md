## 这个 PR 做了什么

<!-- 一句话说清。若有 issue，写 Closes #123 -->

## 为什么

<!-- 解决什么问题；有取舍的话说明取舍 -->

## 怎么验证的

- [ ] `node --check src/server.js`
- [ ] `node scripts/selftest.cjs`
- [ ] `node scripts/check-links.cjs`
- [ ] 手工验证：<!-- 打了哪个端点 / 哪个平台 / 看了哪块 UI -->

## 影响面

- [ ] 改了配置字段 → 已同步 `config.example.json` / `docs/CONFIG.md` / `README.md`
- [ ] 新增周期性工作 → 已加节流，不会每轮空转
- [ ] 涉及 UI → 已用 390px 视口看过手机宽度

## 合规确认

- [ ] 未提交任何真实凭据、`config.json`、`.env`、`state.json`、日志
- [ ] 不涉及绕过付费 / 批量注册 / 代签牟利
