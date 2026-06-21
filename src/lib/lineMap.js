/**
 * Per-file block->line mapping for GitHub rich-diff.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    root.GRDC = root.GRDC || {};
    Object.assign(root.GRDC, api);
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  function isDiagramBlock(el) {
    if (!el) return false;
    if (el.tagName === "PRE") {
      const code = el.querySelector("code");
      const cls = (code && code.className ? code.className : "") + " " + (el.className || "");
      if (/language-mermaid|language-plantuml|language-dot|language-graphviz/i.test(cls)) return true;
      if (el.querySelector("svg") && !(el.textContent || "").trim()) return true;
    }
    if (el.closest && el.closest('[class*="mermaid" i], .highlight-source-mermaid, pre code.language-mermaid')) return true;
    return false;
  }

  function isInDeletedBlock(el) {
    if (!el) return false;
    if (el.tagName === "DEL" || el.tagName === "S") return true;
    if (el.classList && el.classList.contains("removed")) return true;
    return !!(el.closest && el.closest("del, s, .removed"));
  }

  function estimateLines(element) {
    const text = (element && element.textContent) || "";
    const newlines = (text.match(/\n/g) || []).length;
    return Math.max(1, newlines + 1);
  }

  function mapBlocksToSourceLines(richDiff, sourceLines, path, deps, log) {
    if (!richDiff) return new Map();
    const map = new Map();
    const noop = function () {};
    const _log = typeof log === "function" ? log : noop;
    const {
      buildSourceIndex,
      findTextInSource,
      computeTableRowLine,
      findFrontmatterRange
    } = deps || {};

    const sourceIndex = sourceLines && buildSourceIndex ? buildSourceIndex(sourceLines) : null;
    const maxLine = sourceLines ? sourceLines.length : Number.MAX_SAFE_INTEGER;
    const frontmatter = sourceLines && findFrontmatterRange ? findFrontmatterRange(sourceLines) : null;
    const frontmatterTable = frontmatter ? richDiff.querySelector("table") : null;
    const frontmatterRowToLine = new Map();

    if (frontmatterTable && frontmatter && frontmatter.keyLines.length > 0) {
      const bodyRows = frontmatterTable.querySelectorAll(":scope > tbody > tr");
      const allRows = frontmatterTable.querySelectorAll(":scope > thead > tr, :scope > tbody > tr");
      if (bodyRows.length === frontmatter.keyLines.length) {
        bodyRows.forEach((tr, idx) => {
          frontmatterRowToLine.set(tr, frontmatter.keyLines[idx]);
        });
      } else if (allRows.length >= 1) {
        allRows.forEach((tr) => {
          frontmatterRowToLine.set(tr, frontmatter.keyLines[0]);
        });
      }
    }

    const blocks = richDiff.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, tr, pre");
    let fallbackLine = 1;
    let lastOffset = -1;
    let lastLine = 1;
    let matchCount = 0;
    const tableHeaderLine = new Map();

    blocks.forEach((block) => {
      if (isDiagramBlock(block)) return;
      if (isInDeletedBlock(block)) return;
      if (frontmatterTable && frontmatterTable.contains(block)) {
        if (frontmatterRowToLine.has(block)) {
          map.set(block, { path, line: frontmatterRowToLine.get(block) });
        }
        return;
      }
      if (block.tagName === "P" && block.closest("li")) return;

      let rawText = block.textContent;
      if (block.tagName === "LI") {
        const nested = block.querySelector("ul, ol");
        if (nested) rawText = rawText.replace(nested.textContent, "");
      }
      if (block.tagName === "TR") {
        const cells = block.querySelectorAll("td, th");
        if (cells.length) rawText = Array.from(cells).map((c) => c.textContent).join(" ");
      }

      let line;
      if (block.tagName === "TR" && sourceIndex) {
        const table = block.closest("table");
        const allRows = table ? Array.from(table.querySelectorAll("tr")) : [block];
        const rowIndex = allRows.indexOf(block);

        if (rowIndex === 0 || !tableHeaderLine.has(table)) {
          const result = findTextInSource(sourceIndex, rawText, lastOffset);
          if (result.offset > lastOffset) {
            line = result.line;
            lastOffset = result.offset;
            lastLine = line;
            matchCount += 1;
            if (table) tableHeaderLine.set(table, { headerLine: line, rowIndex });
          } else {
            lastLine = Math.min(lastLine + 1, maxLine);
            line = lastLine;
          }
        } else {
          const cached = tableHeaderLine.get(table);
          line = Math.min(computeTableRowLine(cached.headerLine, rowIndex, cached.rowIndex), maxLine);
          lastLine = line;
        }
        map.set(block, { path, line });
        return;
      }

      if (sourceIndex) {
        const result = findTextInSource(sourceIndex, rawText, lastOffset);
        if (result.offset > lastOffset) {
          line = result.line;
          lastOffset = result.offset;
          lastLine = line;
          matchCount += 1;
        } else {
          lastLine = Math.min(lastLine + 1, maxLine);
          line = lastLine;
        }
      } else {
        line = fallbackLine;
        fallbackLine += estimateLines(block);
      }

      map.set(block, { path, line });
    });

    _log(`[GRDC] Mapped ${map.size} elements for ${path} (source-matched: ${!!sourceLines}, text-hits: ${matchCount})`);
    return map;
  }

  function buttonAnchor(element) {
    if (!element) return element;
    if (element.tagName === "TR") {
      return element.querySelector("td, th") || element;
    }
    return element;
  }

  return {
    isDiagramBlock,
    isInDeletedBlock,
    estimateLines,
    mapBlocksToSourceLines,
    buttonAnchor
  };
});
