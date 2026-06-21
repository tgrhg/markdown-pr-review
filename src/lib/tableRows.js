/**
 * Pure arithmetic for mapping rendered table rows to source lines.
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

  function computeTableRowLine(headerLine, rowIndex, headerRowIndex) {
    const hri = headerRowIndex == null ? 0 : headerRowIndex;
    return headerLine + (rowIndex - hri) + 1;
  }

  return { computeTableRowLine };
});
