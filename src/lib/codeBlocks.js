/**
 * Pure code-block / thread-sort helpers.
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

  function findFenceRangeAroundLine(source, targetLine, slack) {
    if (!source || !targetLine) return null;
    const window = typeof slack === "number" ? slack : 5;
    const lines = source.split("\n");
    const fenceRe = /^\s*(`{3,}|~{3,})/;
    const fences = [];
    let openIdx = -1;
    let openMarker = "";
    for (let i = 0; i < lines.length; i += 1) {
      const m = fenceRe.exec(lines[i]);
      if (!m) continue;
      const marker = m[1];
      if (openIdx < 0) {
        openIdx = i;
        openMarker = marker;
      } else if (marker[0] === openMarker[0] && marker.length >= openMarker.length) {
        fences.push({ openLine: openIdx + 1, closeLine: i + 1 });
        openIdx = -1;
        openMarker = "";
      }
    }
    if (!fences.length) return null;
    for (const f of fences) {
      if (targetLine >= f.openLine && targetLine <= f.closeLine) {
        return { start: f.openLine + 1, end: f.closeLine - 1 };
      }
    }
    let best = null;
    let bestDist = Infinity;
    for (const f of fences) {
      const d = Math.min(Math.abs(f.openLine - targetLine), Math.abs(f.closeLine - targetLine));
      if (d < bestDist) {
        best = f;
        bestDist = d;
      }
    }
    if (best && bestDist <= window) {
      return { start: best.openLine + 1, end: best.closeLine - 1 };
    }
    return null;
  }

  function sortThreadHeads(heads) {
    if (!Array.isArray(heads)) return [];
    return heads.slice().sort((a, b) => {
      const aLine = (a && (a.startLine != null ? a.startLine : a.line)) || 0;
      const bLine = (b && (b.startLine != null ? b.startLine : b.line)) || 0;
      if (aLine !== bLine) return aLine - bLine;
      const ta = new Date((a && a.createdAt) || 0).getTime();
      const tb = new Date((b && b.createdAt) || 0).getTime();
      return ta - tb;
    });
  }

  return {
    findFenceRangeAroundLine,
    sortThreadHeads
  };
});
