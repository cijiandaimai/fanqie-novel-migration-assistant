import test from "node:test";
import assert from "node:assert/strict";
import { buildExportPlan, renderNovelMarkdown } from "../src/fanqie-draft-uploader.mjs";

test("合并已发布章节和草稿时默认优先草稿", () => {
  const published = [
    { number: 1, name: "第1章 旧标题", previewUrl: "published-1" },
    { number: 2, name: "第2章 第二章", previewUrl: "published-2" },
  ];
  const drafts = [
    { number: 1, name: "第1章 新标题", editUrl: "draft-1" },
    { number: 3, name: "第3章 第三章", editUrl: "draft-3" },
  ];

  const plan = buildExportPlan(published, drafts);
  assert.deepEqual(plan.map(({ number, title, source }) => ({ number, title, source })), [
    { number: 1, title: "新标题", source: "draft" },
    { number: 2, title: "第二章", source: "published" },
    { number: 3, title: "第三章", source: "draft" },
  ]);
});

test("支持章节范围和已发布优先", () => {
  const published = [{ number: 2, name: "第2章 正式版" }];
  const drafts = [{ number: 2, name: "第2章 草稿版" }, { number: 3, name: "第3章 草稿" }];
  const plan = buildExportPlan(published, drafts, { prefer: "published", startChapter: 2, endChapter: 2 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].title, "正式版");
  assert.equal(plan[0].source, "published");
});

test("生成使用阿拉伯数字章节序号的 Markdown", () => {
  const markdown = renderNovelMarkdown("测试小说", [
    { number: 1, title: "开始", body: "第一段。\n\n\n第二段。" },
    { number: 2, title: "继续", body: "正文。" },
  ]);
  assert.equal(markdown, "# 测试小说\n\n---\n\n## 第1章 开始\n\n第一段。\n\n第二段。\n\n---\n\n## 第2章 继续\n\n正文。\n");
});
