---
name: fanqie-novel-migration
description: Upload Markdown or TXT novels chapter-by-chapter to the Fanqie writer draft box, resume or overwrite drafts, and export published chapters and drafts from a logged-in Fanqie writer account into an ordered Markdown document. Use when the user asks to upload, import, migrate, back up, download, export, or move a Fanqie novel through the Codex in-app browser.
---

# 番茄小说搬家助手

使用插件根目录 `src/fanqie-draft-uploader.mjs` 完成双向搬家。网页任务依赖用户已登录的 Codex 内置浏览器。

## 工作流

1. 确认内置浏览器已打开目标作品的章节管理页或草稿箱。
2. 读取用户意图：本地上传或网站导出。
3. 通过 browser plugin 连接内置浏览器，取得 `iab` 对象。
4. 动态导入插件根目录的主模块。
5. 上传前先运行 `dryRun: true`，核对作品、章节和计划；随后执行正式上传。
6. 导出时确认 `source` 和同章优先级 `prefer`，再执行导出。
7. 输出章节数、首末章、哈希、跳过项或断号提示。
8. 结束浏览器操作前调用 `iab.tabs.finalize(...)`，保留章节管理页并关闭临时页。

## 上传

调用 `runFanqieDraftUpload`：

```js
var result = await helper.runFanqieDraftUpload({
  browser: iab,
  sourceFile: "SOURCE_FILE",
  mode: "resume",
  dryRun: false,
  onProgress: (event) => nodeRepl.write(event),
});
```

- 默认使用 `resume`。
- 用户明确同步修订稿时使用 `overwrite-drafts`。
- 章节序号写入网站时使用阿拉伯数字。
- 等待每章“已保存到云端”后再继续。

## 导出

调用 `runFanqieNovelExport`：

```js
var result = await helper.runFanqieNovelExport({
  browser: iab,
  outputFile: "OUTPUT_FILE.md",
  source: "all",
  prefer: "draft",
  onProgress: (event) => nodeRepl.write(event),
});
```

- `source`：`published`、`drafts`、`all`。
- `prefer`：`draft` 或 `published`。
- 默认导出书名、阿拉伯数字章节标题和章节分隔线。
- 报告 `sequenceWarnings`，并保留已成功写出的文件路径与 SHA-256。

## 详细参数

需要参数表、口令模板或排错说明时读取插件根目录的 `使用说明.md`。
