#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseNovelFile } from "../src/parse-novel.mjs";

const input = process.argv[2];
if (!input) {
  console.error("用法：node bin/prepare-upload.mjs <小说.md|小说.txt> [清单.json]");
  process.exitCode = 1;
} else {
  const result = parseNovelFile(input);
  const output = process.argv[3] || `${path.resolve(input)}.upload-manifest.json`;
  const manifest = {
    sourceFile: result.sourceFile,
    sourceSha256: result.sourceSha256,
    summary: result.summary,
    warnings: result.warnings,
    chapters: result.chapters.map(({ number, title, chars, sourceStartLine, sourceEndLine }) => ({
      number,
      title,
      chars,
      sourceStartLine,
      sourceEndLine,
    })),
  };
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, output, ...result.summary, warnings: result.warnings }, null, 2));
}

