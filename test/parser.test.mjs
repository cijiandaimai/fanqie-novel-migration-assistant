import test from "node:test";
import assert from "node:assert/strict";
import {
  chineseNumberToInteger,
  parseNovelText,
  countPlatformChars,
} from "../src/parse-novel.mjs";

test("中文章节序号转阿拉伯数字", () => {
  assert.equal(chineseNumberToInteger("一"), 1);
  assert.equal(chineseNumberToInteger("十"), 10);
  assert.equal(chineseNumberToInteger("二十一"), 21);
  assert.equal(chineseNumberToInteger("一百零六"), 106);
  assert.equal(chineseNumberToInteger("46"), 46);
});

test("解析 Markdown 小说并清理章末标识", () => {
  const source = `# 书名

## 第一章　开门

**第一段。**

第二段。

---

*第一章完*

## 第2章 进城

正文二。

## 第三章　终点

正文三。
`;
  const result = parseNovelText(source);
  assert.equal(result.chapters.length, 3);
  assert.deepEqual(result.chapters.map((chapter) => chapter.number), [1, 2, 3]);
  assert.deepEqual(result.chapters.map((chapter) => chapter.title), ["开门", "进城", "终点"]);
  assert.equal(result.chapters[0].body, "第一段。\n\n第二段。");
  assert.equal(result.chapters[0].chars, countPlatformChars("第一段。\n\n第二段。"));
  assert.equal(result.chapters[0].body.includes("第一章完"), false);
});

test("重复或断号时报错", () => {
  assert.throws(() => parseNovelText("第一章 A\n正文\n第三章 C\n正文"), /章节序号不连续/);
});

