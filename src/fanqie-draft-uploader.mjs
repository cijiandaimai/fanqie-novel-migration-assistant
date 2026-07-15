import fs from "node:fs";
import path from "node:path";
import { parseNovelFile } from "./parse-novel.mjs";

const FANQIE_HOST = "fanqienovel.com";
const BOOK_ROUTE_RE = /\/chapter-manage\/(\d+)(?:&([^?]+))?/;

function stageError(chapter, stage, error) {
  const wrapped = new Error(`第${chapter?.number ?? "?"}章 / ${stage}: ${error?.message || error}`);
  wrapped.cause = error;
  wrapped.chapter = chapter?.number;
  wrapped.stage = stage;
  return wrapped;
}

function parseBookContext(urlText) {
  const url = new URL(urlText);
  if (!url.hostname.endsWith(FANQIE_HOST)) throw new Error("当前标签页不是番茄小说作家后台。");
  const match = url.pathname.match(BOOK_ROUTE_RE);
  if (!match) throw new Error("当前标签页不是小说章节管理页。");
  return {
    bookId: match[1],
    bookName: match[2] ? decodeURIComponent(match[2]) : "",
    url,
  };
}

function chapterNumberFromName(name) {
  const match = String(name ?? "").match(/第\s*(\d+)\s*章/);
  return match ? Number(match[1]) : null;
}

function manageUrl(urlText, type) {
  const url = new URL(urlText);
  url.searchParams.set("type", String(type));
  url.searchParams.delete("from");
  return url.toString();
}

function absoluteSiteUrl(href) {
  if (!href) return null;
  return new URL(href, "https://fanqienovel.com").toString();
}

async function waitForSnapshot(tab, predicate, { attempts = 50, intervalMs = 300, label = "页面" } = {}) {
  let snapshot = "";
  for (let index = 0; index < attempts; index += 1) {
    snapshot = await tab.playwright.domSnapshot();
    if (predicate(snapshot)) return snapshot;
    await tab.playwright.waitForTimeout(intervalMs);
  }
  throw new Error(`${label}等待超时`);
}

async function waitForList(tab, type) {
  let snapshot = "";
  let stableSignature = "";
  let stableCount = 0;
  let zeroDraftStableCount = 0;

  for (let index = 0; index < 80; index += 1) {
    snapshot = await tab.playwright.domSnapshot();
    const selected = type === 2
      ? snapshot.includes('tab "草稿箱" [selected]')
      : snapshot.includes('tab "章节管理" [selected]');

    if (selected) {
      if (type === 2) {
        const count = Number(snapshot.match(/共(\d+)篇草稿/)?.[1]);
        const observedPages = maxPageFromSnapshot(snapshot);
        const expectedPages = Number.isFinite(count) ? Math.max(1, Math.ceil(count / 15)) : 1;
        if (count === 0) {
          zeroDraftStableCount += 1;
          if (zeroDraftStableCount >= 8) return snapshot;
        } else {
          zeroDraftStableCount = 0;
          if (Number.isFinite(count) && observedPages >= expectedPages) return snapshot;
        }
      } else {
        const tableReady = snapshot.includes("审核状态") || snapshot.includes("发布时间");
        const signature = snapshot.match(/row "第\d+章[^\n]+/g)?.slice(0, 3).join("|") || "empty";
        if (tableReady) {
          if (signature === stableSignature) stableCount += 1;
          else {
            stableSignature = signature;
            stableCount = 1;
          }
          if (stableCount >= 2) return snapshot;
        }
      }
    }
    await tab.playwright.waitForTimeout(300);
  }

  throw new Error(`${type === 2 ? "草稿箱" : "章节管理"}等待超时`);
}

async function readVisibleRows(tab) {
  return tab.playwright.evaluate(() => Array.from(document.querySelectorAll("tbody tr")).map((row) => {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length < 2) return null;
    const name = (cells[0].innerText || "").trim();
    const wordText = (cells[1].innerText || "").trim().replace(/,/g, "");
    const preview = row.querySelector('a[href*="/preview/"]');
    const edit = row.querySelector('a[href*="/publish/"][href*="modifydraft"], a[href*="/publish/"][href*="modifychapter"]');
    return {
      name,
      wordCount: /^\d+$/.test(wordText) ? Number(wordText) : null,
      previewHref: preview?.getAttribute("href") || null,
      editHref: edit?.getAttribute("href") || null,
    };
  }).filter(Boolean));
}

function titleFromChapterName(name, number) {
  const escaped = String(number).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(name ?? "")
    .replace(new RegExp(`^\\s*第\\s*${escaped}\\s*章\\s*`), "")
    .trim();
}

function normalizeExportBody(body) {
  return String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildExportPlan(publishedRows, draftRows, options = {}) {
  const {
    source = "all",
    prefer = "draft",
    startChapter = Number.NEGATIVE_INFINITY,
    endChapter = Number.POSITIVE_INFINITY,
  } = options;
  if (!["all", "published", "drafts"].includes(source)) throw new Error(`不支持的导出来源：${source}`);
  if (!["draft", "published"].includes(prefer)) throw new Error(`不支持的冲突优先级：${prefer}`);

  const byNumber = new Map();
  const addRows = (rows, kind) => {
    for (const row of rows) {
      byNumber.set(row.number, {
        ...row,
        source: kind,
        title: titleFromChapterName(row.name, row.number),
      });
    }
  };

  if (source === "published") addRows(publishedRows, "published");
  else if (source === "drafts") addRows(draftRows, "draft");
  else if (prefer === "draft") {
    addRows(publishedRows, "published");
    addRows(draftRows, "draft");
  } else {
    addRows(draftRows, "draft");
    addRows(publishedRows, "published");
  }

  return [...byNumber.values()]
    .filter((chapter) => chapter.number >= startChapter && chapter.number <= endChapter)
    .sort((a, b) => a.number - b.number);
}

export function renderNovelMarkdown(bookName, chapters, options = {}) {
  const { includeBookTitle = true, chapterSeparator = true } = options;
  const blocks = [];
  if (includeBookTitle) blocks.push(`# ${String(bookName || "未命名作品").trim()}`);
  for (const chapter of chapters) {
    const heading = `## 第${chapter.number}章${chapter.title ? ` ${chapter.title}` : ""}`;
    blocks.push(`${heading}\n\n${normalizeExportBody(chapter.body)}`.trim());
  }
  return `${blocks.join(chapterSeparator ? "\n\n---\n\n" : "\n\n")}\n`;
}

function maxPageFromSnapshot(snapshot) {
  const pages = [...snapshot.matchAll(/listitem "第 (\d+) 页"/g)].map((match) => Number(match[1]));
  return pages.length ? Math.max(...pages) : 1;
}

async function activePage(tab) {
  return tab.playwright.evaluate(() => {
    const active = document.querySelector("li.arco-pagination-item-active");
    const label = active?.getAttribute("aria-label") || "";
    const match = label.match(/第\s*(\d+)\s*页/);
    return match ? Number(match[1]) : 1;
  });
}

async function goToPage(tab, pageNumber) {
  if (await activePage(tab) === pageNumber) return;

  await tab.dom_cua.scroll({ x: 0, y: 10000 });
  let visible = await tab.dom_cua.get_visible_dom();
  let line = visible.split("\n").find((item) => item.includes(`aria-label="第 ${pageNumber} 页"`));

  if (!line) {
    await tab.dom_cua.scroll({ x: 0, y: 10000 });
    visible = await tab.dom_cua.get_visible_dom();
    line = visible.split("\n").find((item) => item.includes(`aria-label="第 ${pageNumber} 页"`));
  }

  const nodeId = line?.match(/node_id=(\d+)/)?.[1];
  if (!nodeId) throw new Error(`没有找到第${pageNumber}页按钮`);
  await tab.dom_cua.click({ node_id: nodeId });

  for (let index = 0; index < 40; index += 1) {
    if (await activePage(tab) === pageNumber) return;
    await tab.playwright.waitForTimeout(250);
  }
  throw new Error(`切换到第${pageNumber}页超时`);
}

async function collectChapterRows(tab, pageUrl, type) {
  if ((await tab.url()) !== pageUrl) {
    await tab.goto(pageUrl);
    await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 20_000 });
  }

  const firstSnapshot = await waitForList(tab, type);
  const pageCount = maxPageFromSnapshot(firstSnapshot);
  const rows = [];

  for (let page = 1; page <= pageCount; page += 1) {
    await goToPage(tab, page);
    const pageRows = await readVisibleRows(tab);
    for (const row of pageRows) {
      const number = chapterNumberFromName(row.name);
      if (!number) continue;
      rows.push({
        ...row,
        number,
        previewUrl: absoluteSiteUrl(row.previewHref),
        editUrl: absoluteSiteUrl(row.editHref),
      });
    }
  }

  if (pageCount > 1) await goToPage(tab, 1);
  return rows;
}

async function findAndClaimManageTab(browser, requestedBookId) {
  const controlledTabs = await browser.tabs.list();
  const controlled = controlledTabs.find((tab) => {
    if (!tab.url?.includes("fanqienovel.com/main/writer/chapter-manage/")) return false;
    if (!requestedBookId) return true;
    return tab.url.includes(`/chapter-manage/${requestedBookId}`);
  });
  if (controlled) return browser.tabs.get(controlled.id);

  const openTabs = await browser.user.openTabs();
  const candidates = openTabs.filter((tab) => {
    if (!tab.url?.includes("fanqienovel.com/main/writer/chapter-manage/")) return false;
    if (!requestedBookId) return true;
    return tab.url.includes(`/chapter-manage/${requestedBookId}`);
  });
  if (!candidates.length) throw new Error("请先在 Codex 内置浏览器打开目标作品的章节管理或草稿箱页面。");
  return browser.user.claimTab(candidates[0]);
}

async function editorLocators(tab) {
  const number = tab.playwright.locator('input.serial-input.byte-input:not([placeholder])');
  const title = tab.playwright.getByPlaceholder("请输入标题", { exact: true });
  const body = tab.playwright.locator('.syl-editor-container.font-size-16.indent-2 div.ProseMirror[contenteditable="true"]');
  const save = tab.playwright.getByRole("button", { name: "存草稿", exact: true });
  const counts = {
    number: await number.count(),
    title: await title.count(),
    body: await body.count(),
    save: await save.count(),
  };
  if (Object.values(counts).some((count) => count !== 1)) {
    throw new Error(`章节编辑控件数量异常：${JSON.stringify(counts)}`);
  }
  return { number, title, body, save };
}

function editorHeader(snapshot) {
  const start = snapshot.indexOf("上次提交");
  const end = snapshot.indexOf("下一步");
  return start >= 0 ? snapshot.slice(start, end > start ? end : start + 500) : snapshot.slice(0, 600);
}

async function waitForEditorStable(tab, expectedChars, { requireSavingCycle = false } = {}) {
  let seenSaving = false;
  let header = "";

  for (let index = 0; index < 100; index += 1) {
    const snapshot = await tab.playwright.domSnapshot();
    header = editorHeader(snapshot);
    if (header.includes("保存中")) seenSaving = true;
    const countReady = header.includes(`"${expectedChars}"`);
    const idle = !header.includes("保存中") && (header.includes("已保存到云端") || header.includes("已保存"));
    if (countReady && idle && (!requireSavingCycle || seenSaving || index >= 3)) return header;
    await tab.playwright.waitForTimeout(300);
  }

  throw new Error(`编辑器同步超时，目标字数：${expectedChars}，状态：${header.slice(0, 160)}`);
}

async function saveChapterInEditor(browser, chapter, editorUrl, options) {
  const { keepFailedEditor = true, cooldownMs = 500 } = options;
  const editorTab = await browser.tabs.new();
  let stage = "打开编辑器";

  try {
    await editorTab.goto(editorUrl);
    await waitForSnapshot(
      editorTab,
      (snapshot) => snapshot.includes("存草稿") && snapshot.includes("请输入标题"),
      { attempts: 60, intervalMs: 300, label: "章节编辑器" },
    );

    stage = "填写正文";
    const locators = await editorLocators(editorTab);
    await locators.number.fill(String(chapter.number));
    await locators.title.fill(chapter.title);
    await locators.body.fill(chapter.body);

    const actual = {
      number: await locators.number.evaluate((element) => element.value),
      title: await locators.title.evaluate((element) => element.value),
      chars: (await locators.body.innerText()).replace(/\s/g, "").length,
    };
    if (actual.number !== String(chapter.number) || actual.title !== chapter.title || actual.chars !== chapter.chars) {
      throw new Error(`填入校验失败：${JSON.stringify(actual)}`);
    }

    stage = "等待自动保存";
    await waitForEditorStable(editorTab, chapter.chars, { requireSavingCycle: true });

    stage = "点击存草稿";
    await locators.save.click();
    await waitForEditorStable(editorTab, chapter.chars);
    if (cooldownMs > 0) await editorTab.playwright.waitForTimeout(cooldownMs);

    const savedEditorUrl = await editorTab.url();
    await editorTab.close();
    return { editorUrl: savedEditorUrl };
  } catch (error) {
    if (!keepFailedEditor) await editorTab.close().catch(() => {});
    throw stageError(chapter, stage, error);
  }
}

function writeCheckpoint(checkpointPath, data) {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, checkpointPath);
}

function buildPlan(chapters, publishedRows, draftRows, options) {
  const published = new Set(publishedRows.map((row) => row.number));
  const drafts = new Map(draftRows.map((row) => [row.number, row]));
  const start = options.startChapter ?? chapters[0].number;
  const end = options.endChapter ?? chapters.at(-1).number;
  const selected = chapters.filter((chapter) => chapter.number >= start && chapter.number <= end);
  const actions = [];
  const skipped = [];

  for (const chapter of selected) {
    if (published.has(chapter.number)) {
      skipped.push({ number: chapter.number, reason: "published" });
      continue;
    }
    const draft = drafts.get(chapter.number);
    if (draft && options.mode !== "overwrite-drafts") {
      skipped.push({ number: chapter.number, reason: "draft-exists", draft });
      continue;
    }
    actions.push({
      kind: draft ? "overwrite" : "create",
      chapter,
      editUrl: draft?.editUrl ?? null,
    });
  }

  return { actions, skipped, published, drafts };
}

export async function runFanqieDraftUpload(options) {
  const {
    browser,
    sourceFile,
    mode = "resume",
    startChapter,
    endChapter,
    bookId: requestedBookId,
    strictSequence = true,
    dryRun = false,
    keepFailedEditor = true,
    cooldownMs = 500,
    checkpointPath: requestedCheckpointPath,
    onProgress,
  } = options ?? {};

  if (!browser?.tabs || !browser?.user) throw new Error("需要传入已连接的 Codex 内置浏览器对象。");
  if (!sourceFile) throw new Error("缺少 sourceFile 小说文件路径。");
  if (!new Set(["resume", "overwrite-drafts"]).has(mode)) throw new Error(`不支持的模式：${mode}`);

  const parsed = parseNovelFile(sourceFile, { strictSequence });
  const listTab = await findAndClaimManageTab(browser, requestedBookId);
  const currentUrl = await listTab.url();
  const book = parseBookContext(currentUrl);
  if (requestedBookId && book.bookId !== String(requestedBookId)) throw new Error("当前作品ID与参数不一致。");

  const publishedUrl = manageUrl(currentUrl, 1);
  const draftUrl = manageUrl(currentUrl, 2);
  const newDraftUrl = `https://fanqienovel.com/main/writer/${book.bookId}/publish/?enter_from=newdraft`;

  onProgress?.({ type: "scan", message: "读取已发布章节" });
  const publishedRows = await collectChapterRows(listTab, publishedUrl, 1);
  onProgress?.({ type: "scan", message: "读取草稿箱" });
  const draftRows = await collectChapterRows(listTab, draftUrl, 2);

  const plan = buildPlan(parsed.chapters, publishedRows, draftRows, {
    mode,
    startChapter,
    endChapter,
  });

  const checkpointPath = requestedCheckpointPath || path.join(
    path.dirname(parsed.sourceFile),
    ".fanqie-upload-state",
    `${book.bookId}-${path.basename(parsed.sourceFile).replace(/[^\p{L}\p{N}._-]+/gu, "_")}.json`,
  );

  const checkpoint = {
    version: 1,
    book,
    sourceFile: parsed.sourceFile,
    sourceSha256: parsed.sourceSha256,
    mode,
    startedAt: new Date().toISOString(),
    completed: [],
    skipped: plan.skipped,
  };

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      book,
      source: parsed.summary,
      warnings: parsed.warnings,
      plan: {
        publishedCount: publishedRows.length,
        draftCount: draftRows.length,
        actions: plan.actions.map((action) => ({ kind: action.kind, number: action.chapter.number, title: action.chapter.title, chars: action.chapter.chars })),
        skipped: plan.skipped,
      },
    };
  }

  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    const editorUrl = action.kind === "overwrite" ? action.editUrl : newDraftUrl;
    if (!editorUrl) throw new Error(`第${action.chapter.number}章缺少草稿编辑地址`);
    onProgress?.({
      type: "chapter-start",
      index: index + 1,
      total: plan.actions.length,
      number: action.chapter.number,
      title: action.chapter.title,
    });

    const saved = await saveChapterInEditor(browser, action.chapter, editorUrl, { keepFailedEditor, cooldownMs });
    const record = {
      kind: action.kind,
      number: action.chapter.number,
      title: action.chapter.title,
      chars: action.chapter.chars,
      editorUrl: saved.editorUrl,
      savedAt: new Date().toISOString(),
    };
    checkpoint.completed.push(record);
    writeCheckpoint(checkpointPath, checkpoint);
    onProgress?.({ type: "chapter-saved", ...record });
  }

  onProgress?.({ type: "verify", message: "复核草稿箱" });
  const finalDraftRows = await collectChapterRows(listTab, draftUrl, 2);
  const finalDrafts = new Map(finalDraftRows.map((row) => [row.number, row]));
  const mismatches = [];

  for (const completed of checkpoint.completed) {
    const row = finalDrafts.get(completed.number);
    const expectedName = `第${completed.number}章 ${completed.title}`;
    if (!row || row.name !== expectedName || row.wordCount !== completed.chars) {
      mismatches.push({
        number: completed.number,
        expectedName,
        expectedChars: completed.chars,
        actual: row ?? null,
      });
    }
  }

  checkpoint.finishedAt = new Date().toISOString();
  checkpoint.finalDraftCount = finalDraftRows.length;
  checkpoint.mismatches = mismatches;
  writeCheckpoint(checkpointPath, checkpoint);

  return {
    ok: mismatches.length === 0,
    book,
    source: parsed.summary,
    warnings: parsed.warnings,
    uploaded: checkpoint.completed,
    skipped: plan.skipped,
    finalDraftCount: finalDraftRows.length,
    mismatches,
    checkpointPath,
    listTab,
  };
}

async function readPublishedBody(tab, chapter) {
  if (!chapter.previewUrl) throw new Error(`第${chapter.number}章缺少预览地址`);
  await tab.goto(chapter.previewUrl);
  await waitForSnapshot(
    tab,
    (snapshot) => snapshot.includes(`第${chapter.number}章`) && snapshot.includes("paragraph:"),
    { attempts: 60, intervalMs: 300, label: `第${chapter.number}章预览页` },
  );
  const content = tab.playwright.locator(".preview-content");
  if (await content.count() !== 1) throw new Error(`第${chapter.number}章预览正文容器数量异常`);
  return normalizeExportBody(await content.innerText());
}

async function readDraftBody(tab, chapter) {
  if (!chapter.editUrl) throw new Error(`第${chapter.number}章缺少草稿编辑地址`);
  await tab.goto(chapter.editUrl);
  await waitForSnapshot(
    tab,
    (snapshot) => snapshot.includes("存草稿") && snapshot.includes("请输入标题"),
    { attempts: 60, intervalMs: 300, label: `第${chapter.number}章草稿编辑器` },
  );

  const locators = await editorLocators(tab);
  let observed = null;
  for (let index = 0; index < 60; index += 1) {
    observed = {
      number: await locators.number.evaluate((element) => element.value),
      title: await locators.title.evaluate((element) => element.value),
      body: normalizeExportBody(await locators.body.innerText()),
    };
    const chars = observed.body.replace(/\s/g, "").length;
    const expectedReady = chapter.wordCount == null || chars === chapter.wordCount;
    if (observed.number === String(chapter.number) && observed.title && observed.body && expectedReady) break;
    await tab.playwright.waitForTimeout(300);
  }

  const chars = observed?.body?.replace(/\s/g, "").length ?? 0;
  if (!observed?.body || observed.number !== String(chapter.number)) {
    throw new Error(`第${chapter.number}章草稿读取校验失败`);
  }
  if (chapter.wordCount != null && chars !== chapter.wordCount) {
    throw new Error(`第${chapter.number}章字数校验失败：列表${chapter.wordCount}，正文${chars}`);
  }
  chapter.title = observed.title.trim();
  return observed.body;
}

export async function runFanqieNovelExport(options) {
  const {
    browser,
    outputFile,
    source = "all",
    prefer = "draft",
    startChapter,
    endChapter,
    bookId: requestedBookId,
    includeBookTitle = true,
    chapterSeparator = true,
    keepFailedReader = true,
    onProgress,
  } = options ?? {};

  if (!browser?.tabs || !browser?.user) throw new Error("需要传入已连接的 Codex 内置浏览器对象。");
  if (!outputFile) throw new Error("缺少 outputFile 导出文件路径。");

  const listTab = await findAndClaimManageTab(browser, requestedBookId);
  const currentUrl = await listTab.url();
  const book = parseBookContext(currentUrl);
  if (requestedBookId && book.bookId !== String(requestedBookId)) throw new Error("当前作品ID与参数不一致。");

  onProgress?.({ type: "scan", message: "读取已发布章节" });
  const publishedRows = source === "drafts" ? [] : await collectChapterRows(listTab, manageUrl(currentUrl, 1), 1);
  onProgress?.({ type: "scan", message: "读取草稿箱" });
  const draftRows = source === "published" ? [] : await collectChapterRows(listTab, manageUrl(currentUrl, 2), 2);
  const plan = buildExportPlan(publishedRows, draftRows, { source, prefer, startChapter, endChapter });
  if (!plan.length) throw new Error("选定范围内没有可导出的章节。");

  const readerTab = await browser.tabs.new();
  const chapters = [];
  try {
    for (let index = 0; index < plan.length; index += 1) {
      const chapter = { ...plan[index] };
      onProgress?.({
        type: "chapter-read",
        index: index + 1,
        total: plan.length,
        number: chapter.number,
        title: chapter.title,
        source: chapter.source,
      });
      try {
        chapter.body = chapter.source === "draft"
          ? await readDraftBody(readerTab, chapter)
          : await readPublishedBody(readerTab, chapter);
      } catch (error) {
        throw stageError(chapter, chapter.source === "draft" ? "读取草稿" : "读取已发布正文", error);
      }
      chapters.push(chapter);
    }
    await readerTab.close();
  } catch (error) {
    if (!keepFailedReader) await readerTab.close().catch(() => {});
    throw error;
  }

  const bookName = book.bookName || `番茄作品-${book.bookId}`;
  const markdown = renderNovelMarkdown(bookName, chapters, { includeBookTitle, chapterSeparator });
  const resolvedOutput = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const temporary = `${resolvedOutput}.tmp`;
  fs.writeFileSync(temporary, markdown, "utf8");
  fs.renameSync(temporary, resolvedOutput);

  const crypto = await import("node:crypto");
  const sha256 = crypto.createHash("sha256").update(markdown).digest("hex");
  const sequenceWarnings = [];
  for (let index = 1; index < chapters.length; index += 1) {
    if (chapters[index].number !== chapters[index - 1].number + 1) {
      sequenceWarnings.push(`第${chapters[index - 1].number}章后直接连接第${chapters[index].number}章`);
    }
  }

  return {
    ok: true,
    book,
    outputFile: resolvedOutput,
    sha256,
    chapterCount: chapters.length,
    publishedCount: chapters.filter((chapter) => chapter.source === "published").length,
    draftCount: chapters.filter((chapter) => chapter.source === "draft").length,
    firstChapter: chapters[0].number,
    lastChapter: chapters.at(-1).number,
    sequenceWarnings,
    listTab,
  };
}

export { parseNovelFile } from "./parse-novel.mjs";
