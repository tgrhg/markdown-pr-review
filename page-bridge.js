(function () {
  "use strict";

  if (window.__MRO_PAGE_BRIDGE_INSTALLED__) return;
  window.__MRO_PAGE_BRIDGE_INSTALLED__ = true;

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.type !== "MRO_PAGE_FETCH_REQUEST") return;

    const requestId = data.requestId;
    const url = data.url;
    const method = typeof data.method === "string" && data.method ? data.method : "GET";
    const body = typeof data.body === "string" ? data.body : undefined;
    const headers = data.headers && typeof data.headers === "object" ? data.headers : null;

    try {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: headers || undefined,
        body
      });

      const text = await response.text();
      window.postMessage(
        {
          type: "MRO_PAGE_FETCH_RESPONSE",
          requestId,
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          text
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          type: "MRO_PAGE_FETCH_RESPONSE",
          requestId,
          ok: false,
          status: 0,
          statusText: "FETCH_ERROR",
          error: error && error.message ? error.message : String(error)
        },
        "*"
      );
    }
  });
})();
