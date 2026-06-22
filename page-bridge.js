(function () {
  "use strict";

  if (window.__MRO_PAGE_BRIDGE_INSTALLED__) return;
  window.__MRO_PAGE_BRIDGE_INSTALLED__ = true;

  const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
  const ALLOWED_HEADERS = new Set([
    "accept",
    "content-type",
    "x-requested-with",
    "github-verified-fetch",
    "x-csrf-token",
    "x-github-api-version"
  ]);
  const MAX_BODY_BYTES = 200000;

  function getPullBasePath() {
    const match = window.location.pathname.match(/^\/[^/]+\/[^/]+\/pull\/\d+/);
    return match ? match[0] : "";
  }

  function isAllowedPath(pathname) {
    const pullBase = getPullBasePath();
    if (!pullBase) return false;

    return (
      pathname === `${pullBase}/changes` ||
      pathname.startsWith(`${pullBase}/page_data/`) ||
      /^\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\//i.test(pathname)
    );
  }

  function sanitizeHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== "object") return out;
    Object.entries(headers).forEach(([name, value]) => {
      const normalized = String(name || "").toLowerCase();
      if (!ALLOWED_HEADERS.has(normalized)) return;
      if (typeof value !== "string") return;
      out[name] = value;
    });
    return out;
  }

  function respond(requestId, payload) {
    window.postMessage(
      {
        type: "MRO_PAGE_FETCH_RESPONSE",
        requestId,
        ...payload
      },
      window.location.origin
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || message.type !== "MRO_PAGE_FETCH_REQUEST") return;

    const requestId = String(message.requestId || "");
    if (!requestId) return;

    let requestUrl;
    try {
      requestUrl = new URL(String(message.url || ""), window.location.href);
    } catch {
      respond(requestId, {
        ok: false,
        status: 400,
        statusText: "BAD_REQUEST",
        error: "Invalid request URL.",
        text: ""
      });
      return;
    }

    if (requestUrl.origin !== window.location.origin) {
      respond(requestId, {
        ok: false,
        status: 403,
        statusText: "FORBIDDEN",
        error: "Cross-origin page fetch is blocked.",
        text: ""
      });
      return;
    }

    const method = String(message.method || "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method) || !isAllowedPath(requestUrl.pathname)) {
      respond(requestId, {
        ok: false,
        status: 403,
        statusText: "FORBIDDEN",
        error: "Blocked by page fetch allowlist.",
        text: ""
      });
      return;
    }

    const body = typeof message.body === "string" ? message.body : undefined;
    if (body && body.length > MAX_BODY_BYTES) {
      respond(requestId, {
        ok: false,
        status: 413,
        statusText: "PAYLOAD_TOO_LARGE",
        error: "Request body too large.",
        text: ""
      });
      return;
    }

    fetch(requestUrl.toString(), {
      method,
      headers: sanitizeHeaders(message.headers),
      body,
      credentials: "include"
    })
      .then(async (response) => {
        const text = await response.text();
        respond(requestId, {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          text
        });
      })
      .catch((error) => {
        respond(requestId, {
          ok: false,
          status: 0,
          statusText: "FETCH_ERROR",
          error: error && error.message ? error.message : String(error),
          text: ""
        });
      });
  });
})();
