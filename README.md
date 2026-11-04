# hermes-translate-plugin

Hermes Desktop「技能与工具」界面的**双速汉化插件** —— 机器翻译秒出结果，LLM 后台润色一键切换。

A dual-speed Chinese localization plugin for Hermes Desktop's Capabilities UI: instant machine translation first, LLM refinement in the background, swap with one click.

## 功能特性

- **⚡ 快译**：谷歌翻译 / MyMemory 免费引擎（可切换、自动互补），秒级出译文
- **✦ 精译**：LLM 按 UI 术语表润色（Skill=技能、Toolset=工具集…），后台运行，一键切换显示版本
- **进度可视**：状态栏实时 `已翻/总数`，停滞时显示 ✗ —— 永远不用猜「在翻」还是「失败」
- **两套词典**：快译/精译分开缓存（`fast.json` / `translations.json`），已翻内容永久复用、不计费
- **超长文本**：按句子边界切块翻译后无缝拼回（万字符级详情页描述全量覆盖）
- **中英混排**：`Use when 需要OCR…` 这类混排句整句翻译
- **只翻该翻的**：仅「技能与工具」页面；聊天、侧边栏、状态栏、代码块、输入框绝不触碰

## 安装

1. 克隆本仓库（或下载 ZIP 解压）：

```bash
git clone https://github.com/<you>/hermes-translate-plugin.git
```

2. 按目录部署到 Hermes：

```
%LOCALAPPDATA%\hermes\plugins\hermes-translate\          ← plugin.yaml / __init__.py / dashboard/
%LOCALAPPDATA%\hermes\desktop-plugins\hermes-translate\  ← desktop/plugin.js
```

3. 启用并重启网关：

```
hermes plugins enable hermes-translate
```

然后在 Hermes Desktop 里 `⌘K` →「界面翻译: 重启网关」。

## 使用

状态栏右侧两个按钮（「手动」左侧）：

| 按钮 | 作用 |
|---|---|
| **⚡ 快译** | 开/关；按钮显示进度 `已翻/总数`，卡住带 ✗ 标记 |
| **✦ 精译** | 切换显示为 LLM 润色版本（未润色完的暂用快译兜底） |

⌘K 命令面板还提供：切换快译引擎（google / mymemory，大陆直连选 mymemory）、重新扫描、调试报告、重启网关。

LLM 使用你自己的模型配置（`.env` 中 `XIAOMI_TP_*` / `XIAOMI_API_KEY` 等环境变量），词典命中不计费。

## 架构

```
desktop/plugin.js        渲染层：MutationObserver + TreeWalker 整节点清扫、
                         双词典查找、增量上屏（applyPending）、双按钮状态栏
dashboard/plugin_api.py  网关层：/fast-translate（免费机翻双引擎互补）、
                         /translate（LLM 标记协议 + 超长切块）、词典缓存
```

设计要点：快译与精译两套词典互为兜底，任何一层落地立即上屏；路由全部同步执行（FastAPI 线程池），不阻塞网关事件循环。

## 文档

- [使用教程](使用教程.md) —— 安装、按钮、⌘K 命令、通知含义
- [注意事项](注意事项.md) —— 常见问题与历史踩坑表（症状 → 根因 → 修复位置）

## License

MIT
