import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DIGITS = new Map([
  ["零", 0], ["〇", 0], ["○", 0],
  ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4],
  ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9],
]);

const SMALL_UNITS = new Map([["十", 10], ["百", 100], ["千", 1000]]);
const LARGE_UNITS = new Map([["万", 10_000], ["亿", 100_000_000]]);

export function chineseNumberToInteger(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!text) return Number.NaN;

  let total = 0;
  let section = 0;
  let number = 0;

  for (const char of text) {
    if (DIGITS.has(char)) {
      number = DIGITS.get(char);
      continue;
    }
    if (SMALL_UNITS.has(char)) {
      const unit = SMALL_UNITS.get(char);
      section += (number || 1) * unit;
      number = 0;
      continue;
    }
    if (LARGE_UNITS.has(char)) {
      const unit = LARGE_UNITS.get(char);
      section += number;
      total += (section || 1) * unit;
      section = 0;
      number = 0;
      continue;
    }
    return Number.NaN;
  }

  return total + section + number;
}

const HEADING_RE = /^(?:#{1,6}\s*)?第\s*([〇零○一二两三四五六七八九十百千万亿\d]+)\s*章(?:\s*[·:：、.．\-—　]\s*|\s+)?(.*?)\s*$/u;

export function parseChapterHeading(line) {
  const text = String(line ?? "").trim();
  if (!text || text.length > 120) return null;
  const match = text.match(HEADING_RE);
  if (!match) return null;
  const number = chineseNumberToInteger(match[1]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    number,
    title: (match[2] || "").trim(),
    raw: text,
  };
}

function isEndMarker(line) {
  const text = String(line ?? "").trim();
  return /^\*{0,3}\s*第\s*[〇零○一二两三四五六七八九十百千万亿\d]+\s*章\s*完\s*\*{0,3}$/u.test(text);
}

function isHorizontalRule(line) {
  return /^(?:-{3,}|_{3,}|\*{3,}|—{3,})$/.test(String(line ?? "").trim());
}

export function cleanChapterBody(linesOrText) {
  let lines = Array.isArray(linesOrText)
    ? [...linesOrText]
    : String(linesOrText ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();

  if (lines.length && isEndMarker(lines.at(-1))) lines.pop();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length && isHorizontalRule(lines.at(-1))) lines.pop();
  while (lines.length && !lines.at(-1).trim()) lines.pop();

  let body = lines.join("\n")
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[^]*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return body;
}

export function countPlatformChars(text) {
  return String(text ?? "").replace(/\s/g, "").length;
}

export function parseNovelText(text, options = {}) {
  const {
    strictSequence = true,
    requireTitle = true,
    minBodyChars = 1,
  } = options;

  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseChapterHeading(lines[index]);
    if (parsed) headings.push({ ...parsed, lineIndex: index });
  }

  if (!headings.length) {
    throw new Error("没有识别到章节标题。支持“## 第一章 标题”或“第1章 标题”。");
  }

  const chapters = headings.map((heading, index) => {
    const nextLine = headings[index + 1]?.lineIndex ?? lines.length;
    const body = cleanChapterBody(lines.slice(heading.lineIndex + 1, nextLine));
    return {
      number: heading.number,
      title: heading.title,
      body,
      chars: countPlatformChars(body),
      sourceStartLine: heading.lineIndex + 1,
      sourceEndLine: nextLine,
      rawHeading: heading.raw,
    };
  });

  const errors = [];
  const warnings = [];
  const seen = new Set();

  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    if (seen.has(chapter.number)) errors.push(`章节序号重复：${chapter.number}`);
    seen.add(chapter.number);

    if (strictSequence) {
      const expected = chapters[0].number + index;
      if (chapter.number !== expected) {
        errors.push(`章节序号不连续：第${chapter.number}章，预期第${expected}章`);
      }
    }
    if (requireTitle && !chapter.title) errors.push(`第${chapter.number}章缺少标题`);
    if (chapter.chars < minBodyChars) errors.push(`第${chapter.number}章正文为空或过短`);
    if (chapter.title.length > 30) warnings.push(`第${chapter.number}章标题超过30字`);
    if (chapter.chars < 1000) warnings.push(`第${chapter.number}章正文少于1000字：${chapter.chars}`);
    if (chapter.chars > 20_000) warnings.push(`第${chapter.number}章正文超过20000字：${chapter.chars}`);
  }

  if (errors.length) {
    const error = new Error(`小说解析校验失败：\n- ${errors.join("\n- ")}`);
    error.details = { errors, warnings, chapters };
    throw error;
  }

  return {
    chapters,
    warnings,
    summary: {
      chapterCount: chapters.length,
      firstChapter: chapters[0].number,
      lastChapter: chapters.at(-1).number,
      totalChars: chapters.reduce((sum, chapter) => sum + chapter.chars, 0),
    },
  };
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

export function parseNovelFile(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  const parsed = parseNovelText(text, options);
  return {
    ...parsed,
    sourceFile: absolutePath,
    sourceSha256: sha256(text),
  };
}

