const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const ALLOWED_HEADERS = new Set([
  "accept",
  "content-type",
  "x-requested-with",
  "github-verified-fetch",
  "x-csrf-token",
  "x-github-api-version"
]);

function isPullPage(pathname) {
  return /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(pathname);
}

function isAllowedSameOriginPath(pathname) {
  return (
    /^\/[^/]+\/[^/]+\/pull\/\d+\/changes$/.test(pathname) ||
    /^\/[^/]+\/[^/]+\/pull\/\d+\/page_data\//.test(pathname) ||
    /^\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\//i.test(pathname) ||
    /^\/graphql$/.test(pathname) ||
    /^\/api\/graphql$/.test(pathname) ||
    /^\/api\/v3\//.test(pathname)
  );
}

function isAllowedCrossOriginPath(requestUrl, senderUrl) {
  return (
    senderUrl.origin === "https://github.com" &&
    (
      (requestUrl.origin === "https://github.com" && requestUrl.pathname.startsWith("/api/v3/")) ||
      requestUrl.origin === "https://api.github.com"
    )
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

function isAllowedRequest(message, sender) {
  if (!message || message.type !== "MRO_BACKGROUND_FETCH") return false;
  if (!sender?.url) return false;

  let senderUrl;
  let requestUrl;
  try {
    senderUrl = new URL(sender.url);
    requestUrl = new URL(message.url);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(senderUrl.protocol)) return false;
  if (!["http:", "https:"].includes(requestUrl.protocol)) return false;
  if (!isPullPage(senderUrl.pathname)) return false;

  const method = String(message.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return false;

  if (requestUrl.origin === senderUrl.origin) {
    return isAllowedSameOriginPath(requestUrl.pathname);
  }

  return isAllowedCrossOriginPath(requestUrl, senderUrl);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "MRO_BACKGROUND_FETCH") return;

  (async () => {
    if (!isAllowedRequest(message, sender)) {
      sendResponse({
        ok: false,
        status: 403,
        statusText: "FORBIDDEN",
        error: "Blocked by extension allowlist.",
        text: ""
      });
      return;
    }

    try {
      const response = await fetch(message.url, {
        method: String(message.method || "GET").toUpperCase(),
        headers: sanitizeHeaders(message.headers),
        body: typeof message.body === "string" ? message.body : undefined,
        credentials: "include"
      });

      const text = await response.text();
      sendResponse({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text
      });
    } catch (error) {
      sendResponse({
        ok: false,
        status: 0,
        statusText: "FETCH_ERROR",
        error: error && error.message ? error.message : String(error),
        text: ""
      });
    }
  })();

  return true;
});
