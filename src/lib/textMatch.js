/**
 * Pure text-matching helpers: render-block text -> source-line resolution.
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

  const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff\ufff9-\ufffb]/g;
  const DIAGRAM_LANGS = new Set(["mermaid", "plantuml", "dot", "graphviz"]);

  function stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/\|/g, " ")
      .replace(/^-{3,}/gm, "");
  }

  function cleanRenderedText(text) {
    return text
      .replace(INVISIBLE_RE, "")
      .replace(/^\+/gm, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function findFrontmatterRange(lines) {
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i += 1;
    if (i >= lines.length || lines[i].trim() !== "---") return null;
    const start = i;
    const keyLines = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "---") {
        return { start: start + 1, end: j + 1, keyLines };
      }
      if (/^[A-Za-z_][\w-]*\s*:/.test(lines[j])) {
        keyLines.push(j + 1);
      }
    }
    return null;
  }

  function buildSourceIndex(sourceLines) {
    const normalize = (s) => s.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim().toLowerCase();
    const masked = sourceLines.slice();
    const frontmatter = findFrontmatterRange(masked);
    if (frontmatter) {
      for (let i = frontmatter.start - 1; i <= frontmatter.end - 1; i += 1) {
        masked[i] = "";
      }
    }

    let inFence = false;
    let fenceLang = "";
    let fenceMarker = "";
    for (let i = 0; i < masked.length; i += 1) {
      const line = masked[i];
      const fenceOpen = line.match(/^(\s*)(```+|~~~+)\s*([\w-]*)/);
      if (!inFence && fenceOpen) {
        inFence = true;
        fenceMarker = fenceOpen[2];
        fenceLang = (fenceOpen[3] || "").toLowerCase();
        continue;
      }
      if (inFence) {
        const closeRe = new RegExp("^\\s*" + fenceMarker.replace(/`/g, "\\`") + "\\s*$");
        if (closeRe.test(line)) {
          inFence = false;
          fenceLang = "";
          continue;
        }
        if (DIAGRAM_LANGS.has(fenceLang)) {
          masked[i] = "";
        }
      }
    }

    const lineOffsets = [];
    let concat = "";
    for (let i = 0; i < masked.length; i += 1) {
      lineOffsets.push(concat.length);
      concat += normalize(stripMarkdown(masked[i])) + " ";
    }
    return { concat, lineOffsets };
  }

  function findLineAtOffset(lineOffsets, pos) {
    for (let i = lineOffsets.length - 1; i >= 0; i -= 1) {
      if (lineOffsets[i] <= pos) return i + 1;
    }
    return 1;
  }

  function findTextInSource(index, text, lastOffset, logger) {
    const fallbackLine = () => findLineAtOffset(index.lineOffsets, lastOffset);
    if (!text) return { line: fallbackLine(), offset: lastOffset };

    const needle = cleanRenderedText(text);
    if (!needle) return { line: fallbackLine(), offset: lastOffset };

    const lengths = [80, 50, 30, 20, 12];
    for (const len of lengths) {
      const chunk = needle.slice(0, len);
      if (chunk.length < 5) continue;

      let pos = index.concat.indexOf(chunk, lastOffset);
      if (pos !== -1) {
        return { line: findLineAtOffset(index.lineOffsets, pos), offset: pos };
      }
      pos = index.concat.indexOf(chunk);
      if (pos !== -1) {
        return { line: findLineAtOffset(index.lineOffsets, pos), offset: pos };
      }
    }

    if (logger && typeof logger === "function") {
      logger("NO MATCH", { needleLen: needle.length, needle: needle.slice(0, 60), lastOffset });
    }
    return { line: fallbackLine(), offset: lastOffset };
  }

  return {
    stripMarkdown,
    cleanRenderedText,
    buildSourceIndex,
    findLineAtOffset,
    findTextInSource,
    findFrontmatterRange,
    DIAGRAM_LANGS
  };
});
