(function () {
  "use strict";

  const {
    buildSourceIndex,
    findTextInSource,
    findFrontmatterRange,
    looksLikePath,
    findBlobInJson,
    threadResponseToComments,
    escapeHtml,
    formatTimeAgo,
    parseMarkersMap,
    buildAnchorKey,
    parseLineFromAnchor,
    computeTableRowLine,
    findFenceRangeAroundLine,
    sortThreadHeads,
    mapBlocksToSourceLines,
    buttonAnchor
  } = (typeof window !== "undefined" && window.GRDC) || {};

  const EXT = "mro";
  const POLL_MS = 700;

  let lastUrl = "";
  let initToken = 0;
  let prInfo = null;
  let routeData = null;
  let fileLineMap = new Map();
  let rawSourceCache = new Map();
  let pathDigestMap = new Map();
  let existingComments = [];
  let pageFetchSequence = 0;
  let reinitTimer = null;
  let runtimeError = "";
  let viewerLogin = "";
  let hudCollapsed = false;
  let activeThreadAnchor = "";
  const movedNativeThreads = new Map();
  let pageBridgeReady = false;
  let pageBridgePromise = null;
  const OID_RE = /[0-9a-f]{40}/i;

  function safeEscapeHtml(value) {
    if (typeof escapeHtml === "function") return escapeHtml(value);
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const requiredHelpers = {
    buildSourceIndex,
    findTextInSource,
    findFrontmatterRange,
    looksLikePath,
    findBlobInJson,
    threadResponseToComments,
    escapeHtml,
    formatTimeAgo,
    parseMarkersMap,
    buildAnchorKey,
    parseLineFromAnchor,
    computeTableRowLine,
    findFenceRangeAroundLine,
    sortThreadHeads,
    mapBlocksToSourceLines,
    buttonAnchor
  };

  function parsePRUrl() {
    const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(files|changes)/);
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2],
      pullNumber: parseInt(match[3], 10),
      origin: window.location.origin
    };
  }

  function detectViewerLogin() {
    const meta = document.querySelector('meta[name="user-login"]');
    if (meta?.content) return meta.content.trim();
    const bodyLogin = document.body?.getAttribute("data-login");
    if (bodyLogin) return bodyLogin.trim();
    return "";
  }

  function detectCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta?.content?.trim() || "";
  }

  async function ensurePageBridge() {
    if (pageBridgeReady) return;
    if (pageBridgePromise) return pageBridgePromise;

    pageBridgePromise = new Promise((resolve, reject) => {
      const existing = document.getElementById("mro-page-bridge");
      if (existing) {
        pageBridgeReady = true;
        resolve();
        return;
      }

      const script = document.createElement("script");
      script.id = "mro-page-bridge";
      script.src = chrome.runtime.getURL("page-bridge.js");
      script.onload = () => {
        pageBridgeReady = true;
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load page bridge."));
      (document.head || document.documentElement).appendChild(script);
    });

    return pageBridgePromise;
  }

  async function pageFetchViaBridge(url, options) {
    await ensurePageBridge();

    const requestId = `mro-page-${Date.now()}-${pageFetchSequence++}`;
    const timeoutMs = 15000;

    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.type !== "MRO_PAGE_FETCH_RESPONSE" || data.requestId !== requestId) return;

        cleanup();
        if (!data.ok && !options?.allowHttpError) {
          reject(new Error(data.error || `HTTP ${data.status} ${data.statusText}`.trim()));
          return;
        }
        resolve({
          ok: data.ok,
          status: data.status,
          statusText: data.statusText,
          text: data.text || ""
        });
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
      };

      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out while requesting ${url}`));
      }, timeoutMs);

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          type: "MRO_PAGE_FETCH_REQUEST",
          requestId,
          url,
          method: options?.method || "GET",
          headers: options?.headers || {},
          body: typeof options?.body === "string" ? options.body : undefined
        },
        window.location.origin
      );
    });
  }

  async function pageFetchViaBackground(url, options) {
    const requestId = `mro-${Date.now()}-${pageFetchSequence++}`;
    const timeoutMs = 15000;

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        reject(new Error(`Timed out while requesting ${url}`));
      }, timeoutMs);

      chrome.runtime.sendMessage(
        {
          type: "MRO_BACKGROUND_FETCH",
          requestId,
          url,
          method: options?.method || "GET",
          headers: options?.headers || {},
          body: typeof options?.body === "string" ? options.body : undefined
        },
        (result) => {
          window.clearTimeout(timeoutId);
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          if (!result) {
            reject(new Error(`Empty response while requesting ${url}`));
            return;
          }
          if (!result.ok && !options?.allowHttpError) {
            reject(new Error(result.error || `HTTP ${result.status} ${result.statusText}`.trim()));
            return;
          }
          resolve({
            ok: result.ok,
            status: result.status,
            statusText: result.statusText,
            text: result.text || ""
          });
        }
      );
    });
  }

  async function pageFetch(url, options) {
    let targetUrl;
    try {
      targetUrl = new URL(url, window.location.href);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (targetUrl.origin === window.location.origin) {
      return pageFetchViaBridge(targetUrl.toString(), options);
    }
    return pageFetchViaBackground(targetUrl.toString(), options);
  }

  async function fetchText(url, acceptOrHeaders) {
    const headers = typeof acceptOrHeaders === "string" ? { Accept: acceptOrHeaders } : (acceptOrHeaders || {});
    try {
      const response = await pageFetch(url, { headers });
      return response.text;
    } catch (error) {
      const message = error?.message || String(error);
      if (!/406/.test(message) || !headers.Accept) throw error;

      const retryHeaders = { ...headers };
      delete retryHeaders.Accept;
      const response = await pageFetch(url, { headers: retryHeaders });
      return response.text;
    }
  }

  function findChangesRouteInJson(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 10) return null;
    if (Array.isArray(node?.diffSummaries) && node?.comparison) return node;

    if (node?.payload?.pullRequestsChangesRoute) {
      return node.payload.pullRequestsChangesRoute;
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === "object") {
        const found = findChangesRouteInJson(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function extractRouteDataFromHtml(html) {
    if (!html || typeof html !== "string") return null;
    const scriptRe = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRe.exec(html)) !== null) {
      try {
        const div = document.createElement("div");
        div.innerHTML = match[1];
        const json = JSON.parse(div.textContent || "");
        const found = findChangesRouteInJson(json);
        if (found) return found;
      } catch (_) {
      }
    }

    return null;
  }

  async function fetchRouteData() {
    if (routeData || !prInfo) return routeData;

    try {
      const url = `${prInfo.origin}/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.pullNumber}/changes`;
      const text = await fetchText(url);

      try {
        const data = JSON.parse(text);
        routeData = data?.payload?.pullRequestsChangesRoute || findChangesRouteInJson(data) || null;
      } catch (_) {
        routeData = extractRouteDataFromHtml(text);
      }
    } catch (e) {
      console.log("[MRO] Failed to fetch route data:", e.message);
    }

    pathDigestMap.clear();
    if (routeData?.diffSummaries) {
      routeData.diffSummaries.forEach((s) => {
        if (s?.pathDigest && s?.path) pathDigestMap.set(s.pathDigest, s.path);
      });
    }
    return routeData;
  }

  function invalidateCaches() {
    routeData = null;
    pathDigestMap = new Map();
    rawSourceCache = new Map();
    existingComments = [];
  }

  async function postJSON(url, body) {
    const csrfToken = detectCsrfToken();
    const response = await pageFetch(url, {
      method: "POST",
      allowHttpError: true,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "GitHub-Verified-Fetch": "true",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {})
      },
      body: JSON.stringify(body)
    });

    let parsed = null;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const errorMessage =
        parsed?.errors?.map((e) => e.message).join(" | ") ||
        parsed?.message ||
        response.text ||
        `HTTP ${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    return parsed;
  }

  async function pageDataPost(candidates, label) {
    if (!prInfo) return { ok: false, error: "No PR info" };
    const base = `${prInfo.origin}/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.pullNumber}/page_data`;
    let lastError = "";

    for (const candidate of candidates) {
      try {
        const response = await pageFetch(`${base}/${candidate.path}`, {
          method: "POST",
          allowHttpError: true,
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "GitHub-Verified-Fetch": "true"
          },
          body: JSON.stringify(candidate.body || {})
        });

        if (response.ok) {
          let data = null;
          try { data = JSON.parse(response.text); } catch {}
          return { ok: true, data, raw: response.text || "" };
        }

        lastError = `HTTP ${response.status}: ${(response.text || "").slice(0, 200)}`;
        console.log(`[MRO] ${label} -> ${candidate.path} failed:`, lastError);
        if (response.status !== 404 && response.status !== 405) {
          continue;
        }
      } catch (error) {
        lastError = error.message || String(error);
        console.log(`[MRO] ${label} -> ${candidate.path} threw:`, lastError);
      }
    }

    return { ok: false, error: lastError || "All endpoint candidates failed." };
  }

  function getFileContainers() {
    return Array.from(document.querySelectorAll('div[id^="diff-"], [data-tagsearch-path], .file[data-path], .file'));
  }

  function getMarkdownDiffSummaryPaths() {
    return (routeData?.diffSummaries || [])
      .map((summary) => summary?.path)
      .filter((path) => isMarkdownPath(path));
  }

  function getFilePath(container) {
    const containerId = container.id || "";
    if (containerId.startsWith("diff-")) {
      for (const [digest, path] of pathDigestMap) {
        if (containerId.includes(digest)) return path;
      }
    }

    let path = container.getAttribute("data-tagsearch-path") || container.getAttribute("data-path");
    if (looksLikePath(path)) return path;

    const copyEls = container.querySelectorAll("clipboard-copy[value]");
    for (const el of copyEls) {
      const value = el.getAttribute("value");
      if (!looksLikePath(value)) continue;
      for (const [, p] of pathDigestMap) {
        if (p === value || p.endsWith("/" + value) || value === p) return p;
      }
      return value;
    }

    const titleLink = container.querySelector('a[title$=".md"], a[title$=".mdx"], a[title$=".markdown"]');
    if (titleLink) {
      const title = titleLink.getAttribute("title");
      if (looksLikePath(title)) {
        for (const [, p] of pathDigestMap) {
          if (p.endsWith(title)) return p;
        }
        return title;
      }
    }

    const blobLink = container.querySelector('a[href*="/blob/"]');
    if (blobLink) {
      const href = blobLink.getAttribute("href") || "";
      const match = href.match(/\/blob\/[^/]+\/(.+)$/i);
      if (match) return decodeURIComponent(match[1]);
    }

    const richDiff = getRichDiff(container);
    if (richDiff) {
      const containers = getFileContainers().filter((item) => !!getRichDiff(item));
      const containerIndex = containers.indexOf(container);
      const markdownPaths = getMarkdownDiffSummaryPaths();
      if (containerIndex >= 0 && containerIndex < markdownPaths.length) {
        return markdownPaths[containerIndex];
      }
    }

    return null;
  }

  function isMarkdownPath(path) {
    return /\.(md|markdown|mdx|mdown|mkdn)$/i.test(path || "");
  }

  function getRichDiff(container) {
    return container.querySelector(".prose-diff .markdown-body") ||
      container.querySelector(".prose-diff") ||
      container.querySelector(".rich-diff-level-one .markdown-body");
  }

  function readOidValue(value) {
    if (!value) return null;
    if (typeof value === "string" && OID_RE.test(value)) {
      const match = value.match(OID_RE);
      return match ? match[0] : null;
    }
    if (typeof value === "object") {
      if (typeof value.oid === "string" && OID_RE.test(value.oid)) return value.oid.match(OID_RE)[0];
      if (typeof value.id === "string" && OID_RE.test(value.id)) return value.id.match(OID_RE)[0];
      if (typeof value.commitOid === "string" && OID_RE.test(value.commitOid)) return value.commitOid.match(OID_RE)[0];
    }
    return null;
  }

  function collectCommitOidsFromJson(node, out, depth) {
    depth = depth || 0;
    if (!node || typeof node !== "object" || depth > 10) return out;

    if (Array.isArray(node)) {
      node.forEach((item) => collectCommitOidsFromJson(item, out, depth + 1));
      return out;
    }

    Object.entries(node).forEach(([key, value]) => {
      const normalized = String(key || "").toLowerCase();
      const oid = readOidValue(value);

      if (oid) {
        if (!out.head && /^(head|headoid|head_oid|headcommit|head_commit|headcommitoid|head_commit_oid|comparisonendoid|comparison_end_oid|headrefoid|head_ref_oid|endcommitoid|end_commit_oid)$/.test(normalized)) {
          out.head = oid;
        }
        if (!out.base && /^(base|baseoid|base_oid|basecommit|base_commit|basecommitoid|base_commit_oid|comparisonstartoid|comparison_start_oid|mergebase|merge_base|mergebaseoid|merge_base_oid|mergebasecommit|merge_base_commit|startcommitoid|start_commit_oid)$/.test(normalized)) {
          out.base = oid;
        }
      }

      if (value && typeof value === "object") {
        if (!out.head && /head/.test(normalized)) {
          const nestedHead = readOidValue(value);
          if (nestedHead) out.head = nestedHead;
        }
        if (!out.base && /(base|comparisonstart|mergebase)/.test(normalized)) {
          const nestedBase = readOidValue(value);
          if (nestedBase) out.base = nestedBase;
        }
        collectCommitOidsFromJson(value, out, depth + 1);
      }
    });

    return out;
  }

  function collectCommitOidsFromText(text, out) {
    if (!text) return out;

    const patterns = [
      { kind: "head", re: /"head(?:Ref|Commit)?(?:Oid|OID|oid)?"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "head", re: /"comparisonEndOid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "head", re: /"comparison_end_oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "head", re: /"end_commit_oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "head", re: /"head_commit_oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "head", re: /"headCommit"\s*:\s*\{[^{}]{0,400}?"oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"base(?:Commit)?(?:Oid|OID|oid)?"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"comparisonStartOid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"comparison_start_oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"mergeBase(?:Commit)?(?:Oid|OID|oid)?"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"merge_base(?:_commit)?_oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"base_commit_oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"start_commit_oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"baseCommit"\s*:\s*\{[^{}]{0,400}?"oid"\s*:\s*"([0-9a-f]{40})"/ig },
      { kind: "base", re: /"mergeBaseCommit"\s*:\s*\{[^{}]{0,400}?"oid"\s*:\s*"([0-9a-f]{40})"/ig }
    ];

    for (const { kind, re } of patterns) {
      if ((kind === "head" && out.head) || (kind === "base" && out.base)) continue;
      const match = re.exec(text);
      if (match?.[1]) out[kind] = match[1];
      re.lastIndex = 0;
    }

    return out;
  }

  function collectCommitOidsFromDom(root, out) {
    const scope = root || document;
    const selectors = [
      "[value]",
      "[data-base-commit-oid]",
      "[data-start-commit-oid]",
      "[data-end-commit-oid]",
      "[data-comparison-start-oid]",
      "[data-comparison-end-oid]"
    ];

    scope.querySelectorAll(selectors.join(",")).forEach((element) => {
      if (out.head && out.base) return;

      const attrs = Array.from(element.attributes || []);
      attrs.forEach((attr) => {
        const name = String(attr.name || "").toLowerCase();
        const value = String(attr.value || "");
        const oid = readOidValue(value);
        if (!oid) return;

        if (!out.head && /(head|comparison_end|end_commit)/.test(name)) {
          out.head = oid;
        }
        if (!out.base && /(base|comparison_start|start_commit|merge_base)/.test(name)) {
          out.base = oid;
        }
      });
    });

    return out;
  }

  function discoverCommitOids(container) {
    const oids = { head: null, base: null };
    const blobLink = (container || document).querySelector('a[href*="/blob/"]');
    if (blobLink) {
      const m = blobLink.getAttribute("href").match(/\/blob\/([0-9a-f]{40})\//);
      if (m) oids.head = m[1];
    }

    for (const script of document.querySelectorAll('script[type="application/json"], script')) {
      const text = script.textContent || "";
      collectCommitOidsFromText(text, oids);
      try {
        const parsed = JSON.parse(text);
        collectCommitOidsFromJson(parsed, oids);
      } catch (_) {
      }
      if (oids.head && oids.base) break;
    }

    collectCommitOidsFromDom(container || document, oids);
    if (!oids.head || !oids.base) {
      collectCommitOidsFromDom(document, oids);
    }

    if (routeData?.comparison?.fullDiff?.headOid) oids.head = routeData.comparison.fullDiff.headOid;
    if (routeData?.comparison?.fullDiff?.baseOid) oids.base = routeData.comparison.fullDiff.baseOid;
    if (routeData?.comparison?.fullDiff?.comparisonStartOid) oids.base = routeData.comparison.fullDiff.comparisonStartOid;
    return oids;
  }

  async function resolveComparisonOids(container) {
    if (!routeData) {
      try {
        await fetchRouteData();
      } catch (_) {
      }
    }

    const discovered = discoverCommitOids(container || document);
    const comparison = routeData?.comparison || {};
    const fullDiff = comparison?.fullDiff || {};

    const headOid =
      prInfo?.headOid ||
      comparison.headOid ||
      comparison.comparisonEndOid ||
      comparison.headCommitOid ||
      fullDiff.headOid ||
      fullDiff.comparisonEndOid ||
      fullDiff.headCommitOid ||
      discovered.head ||
      null;

    const baseOid =
      prInfo?.baseOid ||
      comparison.comparisonStartOid ||
      comparison.baseOid ||
      comparison.mergeBaseOid ||
      comparison.baseCommitOid ||
      fullDiff.comparisonStartOid ||
      fullDiff.baseOid ||
      fullDiff.mergeBaseOid ||
      fullDiff.baseCommitOid ||
      discovered.base ||
      null;

    if (prInfo) {
      if (headOid) prInfo.headOid = headOid;
      if (baseOid) prInfo.baseOid = baseOid;
    }

    return { head: headOid, base: baseOid };
  }

  async function fetchRawSource(container, path) {
    if (rawSourceCache.has(path)) return rawSourceCache.get(path);

    const oids = discoverCommitOids(container);
    if (!prInfo || !looksLikePath(path)) return null;

    const blobCandidates = [];
    const exactBlobLink = container.querySelector('a[href*="/blob/"]');
    if (exactBlobLink) {
      try {
        blobCandidates.push(new URL(exactBlobLink.getAttribute("href"), prInfo.origin).toString());
      } catch (_) {
      }
    }
    if (oids.head) {
      blobCandidates.push(`${prInfo.origin}/${prInfo.owner}/${prInfo.repo}/blob/${oids.head}/${encodeURI(path)}`);
    }

    const uniqueBlobCandidates = Array.from(new Set(blobCandidates));
    if (!uniqueBlobCandidates.length) return null;

    for (const blobUrl of uniqueBlobCandidates) {
      try {
        const html = await fetchText(blobUrl);

        let m = html.match(/<textarea[^>]*id=["']read-only-cursor-text-area["'][^>]*>([\s\S]*?)<\/textarea>/);
        if (!m) {
          m = html.match(/<textarea[^>]*data-testid=["']read-only-cursor-text-area["'][^>]*>([\s\S]*?)<\/textarea>/);
        }
        if (!m) {
          m = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
        }
        if (m) {
          const div = document.createElement("div");
          div.innerHTML = m[1];
          const text = div.textContent || "";
          if (text) {
            rawSourceCache.set(path, text);
            return text;
          }
        }

        const scriptRe = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g;
        let scriptMatch;
        while ((scriptMatch = scriptRe.exec(html)) !== null) {
          if (!scriptMatch[1].includes("rawLines") && !scriptMatch[1].includes("rawBlob")) continue;
          try {
            const div = document.createElement("div");
            div.innerHTML = scriptMatch[1];
            const json = JSON.parse(div.textContent);
            const found = findBlobInJson(json);
            if (found) {
              rawSourceCache.set(path, found);
              return found;
            }
          } catch (_) {
          }
        }
      } catch (e) {
        console.log("[MRO] Blob HTML error for", path, blobUrl, e.message);
      }
    }

    return null;
  }

  async function buildLineMap() {
    fileLineMap = new Map();
    const eligible = [];
    for (const container of getFileContainers()) {
      const path = getFilePath(container);
      if (!isMarkdownPath(path)) continue;
      const richDiff = getRichDiff(container);
      if (!richDiff) continue;
      eligible.push({ container, path, richDiff });
    }

    const rawSources = await Promise.all(
      eligible.map(({ container, path }) => fetchRawSource(container, path))
    );

    const deps = {
      buildSourceIndex,
      findTextInSource,
      computeTableRowLine,
      findFrontmatterRange
    };

    eligible.forEach(({ path, richDiff }, idx) => {
      const rawSource = rawSources[idx];
      const sourceLines = rawSource ? rawSource.split("\n") : null;
      const perFileMap = mapBlocksToSourceLines(richDiff, sourceLines, path, deps, console.log.bind(console));
      perFileMap.forEach((info, el) => fileLineMap.set(el, info));
    });
  }

  function topUnderlinedAncestor(node) {
    let top = null;
    let cur = node && node.parentElement;
    while (cur && cur !== document.body) {
      if (cur.classList && (cur.classList.contains("markdown-body") || cur.classList.contains("rich-diff-level-one"))) break;
      const tag = cur.tagName;
      if (tag === "INS" || tag === "U" || tag === "DEL" || tag === "S") top = cur;
      else if (cur.classList && (cur.classList.contains("removed") || cur.classList.contains("added"))) top = cur;
      cur = cur.parentElement;
    }
    return top;
  }

  function createInsertAnchor(element) {
    if (element.tagName === "TR") {
      const table = element.closest("table") || element;
      const host = topUnderlinedAncestor(table) || table;
      return {
        insert(node, beforeNode) {
          if (beforeNode && beforeNode.parentNode === host.parentNode) host.parentNode.insertBefore(node, beforeNode);
          else host.after(node);
        },
        nextNode() {
          return host.nextElementSibling;
        }
      };
    }

    if (element.tagName === "LI") {
      const listItem = element;
      const nested = listItem.querySelector(":scope > ul, :scope > ol");
      return {
        insert(node, beforeNode) {
          if (beforeNode && beforeNode.parentNode === listItem) {
            listItem.insertBefore(node, beforeNode);
            return;
          }
          if (nested && nested.parentNode === listItem) listItem.insertBefore(node, nested);
          else listItem.appendChild(node);
        },
        nextNode() {
          return nested && nested.parentNode === listItem ? nested.previousElementSibling : listItem.lastElementChild;
        }
      };
    }

    const host = topUnderlinedAncestor(element) || element;
    return {
      insert(node, beforeNode) {
        if (beforeNode && beforeNode.parentNode === host.parentNode) host.parentNode.insertBefore(node, beforeNode);
        else host.after(node);
      },
      nextNode() {
        return host.nextElementSibling;
      }
    };
  }

  function getRenderedThreadElements() {
    return Array.from(document.querySelectorAll(".grdc-existing-thread, .grdc-native-thread"))
      .filter((element) => element instanceof HTMLElement && element.isConnected)
      .sort((a, b) => {
        const aLine = parseLineFromAnchor(a.dataset.grdcAnchor || "") ?? Number.MAX_SAFE_INTEGER;
        const bLine = parseLineFromAnchor(b.dataset.grdcAnchor || "") ?? Number.MAX_SAFE_INTEGER;
        if (aLine !== bLine) return aLine - bLine;
        const ay = a.getBoundingClientRect().top + window.scrollY;
        const by = b.getBoundingClientRect().top + window.scrollY;
        return ay - by;
      });
  }

  function getCurrentThreadIndex(threads) {
    if (!threads.length) return -1;
    if (activeThreadAnchor) {
      const exact = threads.findIndex((thread) => (thread.dataset.grdcAnchor || "") === activeThreadAnchor);
      if (exact >= 0) return exact;
    }

    const viewportMid = window.scrollY + (window.innerHeight * 0.5);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    threads.forEach((thread, index) => {
      const rect = thread.getBoundingClientRect();
      const center = rect.top + window.scrollY + (rect.height * 0.5);
      const distance = Math.abs(center - viewportMid);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function highlightThread(thread) {
    thread.classList.remove("grdc-thread-active");
    void thread.offsetWidth;
    thread.classList.add("grdc-thread-active");
    window.setTimeout(() => thread.classList.remove("grdc-thread-active"), 1800);
  }

  function bindThreadFocus(element) {
    if (!element || element.dataset.grdcFocusBound === "1") return;
    element.dataset.grdcFocusBound = "1";
    element.addEventListener("click", () => {
      activeThreadAnchor = element.dataset.grdcAnchor || "";
      renderHud();
    });
  }

  function focusThreadByIndex(index) {
    const threads = getRenderedThreadElements();
    if (!threads.length) return;
    const normalized = ((index % threads.length) + threads.length) % threads.length;
    const thread = threads[normalized];
    activeThreadAnchor = thread.dataset.grdcAnchor || "";
    if (thread.classList.contains("grdc-existing-thread")) {
      const body = thread.querySelector(".grdc-thread-body");
      if (body) body.style.display = "block";
    }
    thread.scrollIntoView({ behavior: "smooth", block: "center" });
    highlightThread(thread);
    renderHud();
  }

  function navigateThreads(delta) {
    const threads = getRenderedThreadElements();
    if (!threads.length) return;
    const current = getCurrentThreadIndex(threads);
    focusThreadByIndex((current < 0 ? 0 : current) + delta);
  }

  function renderHud() {
    document.querySelectorAll(`.${EXT}-hud`).forEach((el) => el.remove());
    document.querySelectorAll(`.${EXT}-hud-pill`).forEach((el) => el.remove());
    const containers = getFileContainers();
    const markdownFiles = containers.map(getFilePath).filter(isMarkdownPath).length;
    const richDiffFiles = containers.filter((c) => {
      const path = getFilePath(c);
      return isMarkdownPath(path) && !!getRichDiff(c);
    }).length;
    const commentableBlocks = fileLineMap.size;
    const openThreads = getRenderedThreadElements();
    const currentThreadIndex = getCurrentThreadIndex(openThreads);
    const reviewableFiles = new Set(existingComments.map((comment) => comment.path).filter(Boolean)).size;
    const note = runtimeError || (richDiffFiles === 0
      ? "Rich Diff を開いたあとに Reload / Rescan を押してください。"
      : commentableBlocks === 0
        ? "Rich Diff は読めていますが、行マッピングがまだ作れていません。対象 markdown の raw 取得を再試行してください。"
        : "Next / Prev で未解決 thread を順に確認できます。");

    if (hudCollapsed) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `${EXT}-hud-pill`;
      pill.innerHTML = `<span>MRO</span><strong>${openThreads.length}</strong>`;
      pill.title = "Open Markdown Review Overlay";
      pill.addEventListener("click", () => {
        hudCollapsed = false;
        renderHud();
      });
      document.body.appendChild(pill);
      return;
    }

    const hud = document.createElement("aside");
    hud.className = `${EXT}-hud`;
    hud.innerHTML = `
      <div class="${EXT}-hud-top">
        <div>
          <div class="${EXT}-hud-eyebrow">Markdown Review Overlay</div>
          <div class="${EXT}-hud-title">${safeEscapeHtml(window.location.host)}</div>
        </div>
        <div class="${EXT}-hud-controls">
          <button type="button" class="${EXT}-hud-toggle" data-action="collapse" title="Collapse">-</button>
          <button type="button" class="${EXT}-hud-action">Reload / Rescan</button>
        </div>
      </div>
      <div class="${EXT}-hud-body">
        <div class="${EXT}-hud-nav">
          <button type="button" class="${EXT}-hud-toggle" data-action="prev-thread" title="Previous thread">↑</button>
          <div class="${EXT}-hud-position">
            <strong>${openThreads.length ? currentThreadIndex + 1 : 0} / ${openThreads.length}</strong>
            <span>Open Threads</span>
          </div>
          <button type="button" class="${EXT}-hud-toggle" data-action="next-thread" title="Next thread">↓</button>
        </div>
        <div class="${EXT}-hud-grid">
          <div class="${EXT}-hud-stat"><strong>${openThreads.length}</strong><span>Open threads</span></div>
          <div class="${EXT}-hud-stat"><strong>${reviewableFiles}</strong><span>Files with threads</span></div>
          <div class="${EXT}-hud-stat"><strong>${richDiffFiles}</strong><span>Rich diff files</span></div>
          <div class="${EXT}-hud-stat"><strong>${markdownFiles}</strong><span>Markdown files</span></div>
        </div>
        <div class="${EXT}-hud-note">${safeEscapeHtml(note)}</div>
      </div>
    `;
    hud.addEventListener("click", (event) => {
      const actionEl = event.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.getAttribute("data-action");
      if (action === "collapse") {
        hudCollapsed = true;
        renderHud();
        return;
      }
      if (action === "prev-thread") {
        navigateThreads(-1);
        return;
      }
      if (action === "next-thread") {
        navigateThreads(1);
      }
    });
    hud.querySelector(`.${EXT}-hud-action`).addEventListener("click", () => {
      activeThreadAnchor = "";
      invalidateCaches();
      scheduleReinit();
    });
    document.body.appendChild(hud);
  }

  function attachCommentButtons() {
    document.querySelectorAll(".grdc-comment-btn").forEach((el) => el.remove());
    document.querySelectorAll(".grdc-hoverable").forEach((el) => el.classList.remove("grdc-hoverable"));

    fileLineMap.forEach((info, element) => {
      const host = buttonAnchor(element);
      host.classList.add("grdc-hoverable");
      const btn = document.createElement("button");
      btn.className = "grdc-comment-btn";
      btn.innerHTML = '<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      btn.title = `Comment on ${info.path}:${info.line}`;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCommentBox(element, info);
      });
      host.prepend(btn);
    });
  }

  function fetchExistingComments() {
    const threads = routeData?.markers?.threads || {};
    const markerMap = parseMarkersMap(routeData?.diffSummaries || []);
    const comments = [];

    Object.entries(threads).forEach(([threadId, thread]) => {
      if (thread?.isResolved) return;
      const anchor = markerMap.get(String(threadId));
      if (!anchor) return;
      const rawComments = thread?.commentsData?.comments || thread?.comments || [];
      rawComments.forEach((c, idx) => {
        comments.push({
          path: anchor.path,
          line: anchor.line,
          startLine: anchor.startLine,
          body: c.body || c.bodyText || "",
          bodyHTML: c.bodyHTML || "",
          user: c?.author?.login || c?.user?.login || "unknown",
          createdAt: c.createdAt || c.created_at || new Date().toISOString(),
          htmlUrl: c.url || c.htmlUrl || c.html_url || "",
          threadId,
          threadNodeId: thread?.id || String(threadId),
          isResolved: !!thread?.isResolved,
          isOutdated: !!(thread?.isOutdated || thread?.outdated),
          viewerCanReply: thread?.viewerCanReply !== false,
          viewerCanResolve: thread?.viewerCanResolve !== false,
          viewerCanDelete: c?.viewerCanDelete === true,
          commentNodeId: c?.id || c?.node_id || null,
          dbId: c.databaseId ?? c.database_id ?? c.id ?? null,
          headDbId: rawComments[0]?.databaseId ?? rawComments[0]?.database_id ?? rawComments[0]?.id ?? null,
          isHead: idx === 0
        });
      });
    });

    return comments;
  }

  function findAnchorElement(path, line, startLine) {
    const targetLine = startLine != null ? startLine : line;
    let exact = null;
    let best = null;
    let bestDistance = Infinity;

    fileLineMap.forEach((info, element) => {
      if (info.path !== path) return;
      if (info.line === targetLine) exact = element;
      const distance = Math.abs(info.line - targetLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = element;
      }
    });

    return exact || best;
  }

  function upsertThreadComments(nextComments) {
    if (!nextComments.length) return;
    const threadId = String(nextComments[0].threadId || "");
    existingComments = existingComments.filter((comment) => String(comment.threadId || "") !== threadId);
    existingComments.push(...nextComments.filter((comment) => !comment.isResolved));
  }

  function removeCommentLocally(commentNodeId) {
    existingComments = existingComments.filter((comment) => String(comment.dbId ?? "") !== String(commentNodeId));
  }

  function resolveThreadLocally(threadId) {
    existingComments = existingComments.filter((comment) => String(comment.threadId || "") !== String(threadId || ""));
  }

  function buildOptimisticComment(path, line, body) {
    const threadId = `local-${Date.now()}`;
    return [{
      path,
      line,
      startLine: null,
      body,
      bodyHTML: "",
      user: viewerLogin || "you",
      createdAt: new Date().toISOString(),
      htmlUrl: "",
      threadId,
      threadNodeId: threadId,
      isResolved: false,
      isOutdated: false,
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanDelete: true,
      commentNodeId: null,
      dbId: null,
      headDbId: null,
      isHead: true
    }];
  }

  function restoreMovedNativeThreads() {
    movedNativeThreads.forEach((state, element) => {
      if (!state?.placeholder?.parentNode) return;
      state.placeholder.parentNode.insertBefore(element, state.placeholder);
      state.placeholder.remove();
      element.classList.remove("grdc-native-thread");
    });
    movedNativeThreads.clear();
  }

  function closestNativeThreadHost(node) {
    if (!(node instanceof Element)) return null;
    let cur = node;
    while (cur && cur !== document.body) {
      if (isNativeThreadContainer(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function isNativeThreadContainer(element) {
    if (!(element instanceof Element)) return false;
    const selectorMatch = element.matches(
      ".js-resolvable-thread, [data-testid='review-thread'], .review-thread, .js-inline-comments-container, .js-comment-holder, .TimelineItem, tr, details, .js-minimizable-comment-group, .review-comment, [id^='pullrequestreview-']"
    );
    if (!selectorMatch) return false;

    const hasDiscussionAnchor =
      !!element.querySelector("[id^='discussion_r'], a[href*='#discussion_r']") ||
      /^discussion_r\d+$/.test(element.id || "");

    const hasReviewUi =
      !!element.querySelector("textarea, button, summary, form") &&
      /(reply|resolve|resolved|delete|outdated|conversation)/i.test(element.textContent || "");

    const hasCommentShape =
      !!element.querySelector(".comment, .timeline-comment, .review-comment, [data-comment-id], [data-review-comment-id]");

    return hasDiscussionAnchor || (hasReviewUi && hasCommentShape);
  }

  function findNativeThreadByDiscussionId(id) {
    const direct = document.getElementById(`discussion_r${id}`);
    const directHost = closestNativeThreadHost(direct);
    if (directHost) return directHost;

    const anchorLink = document.querySelector(`a[href*="#discussion_r${id}"]`);
    const linkHost = closestNativeThreadHost(anchorLink);
    if (linkHost) return linkHost;

    const anyId = document.querySelector(`[id="discussion_r${id}"]`);
    const anyHost = closestNativeThreadHost(anyId);
    if (anyHost) return anyHost;

    return null;
  }

  function findNativeThreadElement(threadComments) {
    const ids = Array.from(new Set(
      threadComments.flatMap((comment) => [comment.dbId, comment.headDbId]).filter(Boolean).map(String)
    ));

    for (const id of ids) {
      const discussionHost = findNativeThreadByDiscussionId(id);
      if (discussionHost) return discussionHost;

      const attrHost = document.querySelector(
        `[data-comment-id="${id}"], [data-review-comment-id="${id}"], [data-discussion-id="${id}"], [data-id="${id}"]`
      );
      const normalizedHost = closestNativeThreadHost(attrHost);
      if (normalizedHost) return normalizedHost;
    }

    for (const comment of threadComments) {
      if (!comment.htmlUrl) continue;
      const byUrl = document.querySelector(`a[href="${CSS.escape(comment.htmlUrl)}"]`);
      const host = closestNativeThreadHost(byUrl);
      if (host) return host;
    }

    return null;
  }

  function mountNativeThreadOnElement(element, threadComments) {
    const nativeThread = findNativeThreadElement(threadComments);
    if (!nativeThread) return false;
    if (!movedNativeThreads.has(nativeThread)) {
      const placeholder = document.createComment("grdc-native-thread-placeholder");
      nativeThread.parentNode?.insertBefore(placeholder, nativeThread);
      movedNativeThreads.set(nativeThread, { placeholder });
    }
    nativeThread.classList.add("grdc-native-thread");
    const anchor = createInsertAnchor(element);
    const anchorLine = threadComments[0].startLine != null ? threadComments[0].startLine : threadComments[0].line;

    let insertBefore = null;
    let probe = anchor.nextNode();
    while (probe) {
      if (probe.classList?.contains("grdc-existing-thread") || probe.classList?.contains("grdc-native-thread")) {
        const probeLine = parseLineFromAnchor(probe.dataset.grdcAnchor || "");
        if (probeLine != null && probeLine > anchorLine) {
          insertBefore = probe;
          break;
        }
      } else if (!probe.classList?.contains("grdc-existing-thread")) {
        break;
      }
      probe = probe.nextElementSibling;
    }

    nativeThread.dataset.grdcAnchor = buildAnchorKey(threadComments[0]);
    bindThreadFocus(nativeThread);
    anchor.insert(nativeThread, insertBefore);
    return true;
  }

  function appendReplyLocally(anchorComment, reply) {
    const threadComments = existingComments.filter((comment) => String(comment.threadId || "") === String(anchorComment.threadId || ""));
    const head = threadComments[0] || anchorComment;
    const next = {
      path: head.path,
      line: head.line,
      startLine: head.startLine,
      body: reply.body || "",
      bodyHTML: reply.body_html || reply.bodyHTML || "",
      user: reply?.user?.login || viewerLogin || "you",
      createdAt: reply.created_at || reply.createdAt || new Date().toISOString(),
      htmlUrl: reply.html_url || reply.url || "",
      threadId: head.threadId,
      threadNodeId: head.threadNodeId,
      isResolved: false,
      isOutdated: !!head.isOutdated,
      viewerCanReply: head.viewerCanReply !== false,
      viewerCanResolve: head.viewerCanResolve !== false,
      viewerCanDelete: true,
      commentNodeId: null,
      dbId: reply.id ?? null,
      headDbId: head.headDbId ?? head.dbId ?? null,
      isHead: false
    };

    existingComments.push(next);
  }

  function showThreadError(threadEl, message) {
    const errorEl = threadEl.querySelector(".grdc-thread-error");
    if (!errorEl) return;
    errorEl.hidden = false;
    errorEl.textContent = `✗ ${message}`;
  }

  function clearThreadError(threadEl) {
    const errorEl = threadEl.querySelector(".grdc-thread-error");
    if (!errorEl) return;
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  function setButtonBusy(button, busyLabel) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    return () => {
      button.disabled = false;
      button.textContent = original;
    };
  }

  async function resolveReviewThread(threadNodeId) {
    return pageDataPost(
      [{ path: "resolve_thread", body: { threadId: threadNodeId } }],
      `resolve(thread=${threadNodeId})`
    );
  }

  async function deleteReviewComment(commentNodeId) {
    if (!prInfo) return { ok: false, error: "No PR info" };
    try {
      const response = await pageFetch(
        `${prInfo.origin}/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.pullNumber}/page_data/review_comments/${commentNodeId}`,
        {
          method: "DELETE",
          allowHttpError: true,
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "GitHub-Verified-Fetch": "true"
          }
        }
      );
      if (response.ok) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}: ${(response.text || "").slice(0, 200)}` };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  async function replyToReviewComment(commentId, body) {
    const oids = await resolveComparisonOids(document);
    const headOid = oids.head;
    const baseOid = oids.base;

    return pageDataPost(
      [{
        path: "create_review_comment",
        body: {
          inReplyTo: commentId,
          text: body,
          submitBatch: true,
          comparisonStartOid: baseOid,
          comparisonEndOid: headOid
        }
      }],
      `reply(inReplyTo=${commentId})`
    );
  }

  function createThreadElement(headComments) {
    const head = headComments[0];
    const wrap = document.createElement("div");
    wrap.className = "grdc-existing-thread";
    wrap.dataset.grdcAnchor = buildAnchorKey(head);
    wrap.dataset.threadId = String(head.threadId || "");
    wrap.innerHTML = `
      <button type="button" class="grdc-thread-badge">💬 ${headComments.length} comment${headComments.length > 1 ? "s" : ""}</button>
      <div class="grdc-thread-body" style="display:none;"></div>
    `;
    const badge = wrap.querySelector(".grdc-thread-badge");
    const body = wrap.querySelector(".grdc-thread-body");

    const commentsHtml = headComments.map((comment) => {
      const canDelete = comment.viewerCanDelete || (viewerLogin && comment.user === viewerLogin);
      const deleteId = comment.dbId || "";
      return `
        <div class="grdc-thread-comment" data-comment-id="${safeEscapeHtml(String(deleteId))}">
          <div class="grdc-thread-meta">
            <strong>${escapeHtml(comment.user)}</strong>
            <span>${escapeHtml(formatTimeAgo(comment.createdAt))}</span>
          </div>
          <div class="grdc-thread-text">${comment.bodyHTML || escapeHtml(comment.body).replace(/\n/g, "<br>")}</div>
          ${canDelete && deleteId ? `
            <div class="grdc-thread-comment-actions">
              <button type="button" class="grdc-mini-btn" data-action="delete" data-comment-id="${safeEscapeHtml(String(deleteId))}">Delete</button>
            </div>
          ` : ""}
        </div>
      `;
    }).join("");

    const openUrl = headComments.find((comment) => comment.htmlUrl)?.htmlUrl || "";
    body.innerHTML = `
      ${commentsHtml}
      <div class="grdc-thread-actions">
        ${head.viewerCanReply !== false ? '<button type="button" class="grdc-mini-btn" data-action="reply">Reply</button>' : ""}
        ${head.viewerCanResolve !== false ? '<button type="button" class="grdc-mini-btn" data-action="resolve">Resolve</button>' : ""}
        ${openUrl ? `<a class="grdc-mini-btn" href="${safeEscapeHtml(openUrl)}" target="_blank" rel="noreferrer">Open</a>` : ""}
      </div>
      <div class="grdc-thread-reply" hidden>
        <textarea class="grdc-editor-textarea grdc-editor-textarea-inline" rows="4" placeholder="Reply to this thread..."></textarea>
        <div class="grdc-comment-actions grdc-comment-actions-inline">
          <button class="grdc-btn grdc-btn-cancel" data-action="cancel-reply">Cancel</button>
          <button class="grdc-btn grdc-btn-primary" data-action="submit-reply">Reply</button>
        </div>
      </div>
      <div class="grdc-thread-error" hidden></div>
    `;

    badge.addEventListener("click", () => {
      body.style.display = body.style.display === "none" ? "block" : "none";
    });
    return wrap;
  }

  function bindThreadActions(threadEl, threadComments) {
    const body = threadEl.querySelector(".grdc-thread-body");
    if (!body) return;
    const anchorComment = threadComments[0];

    body.addEventListener("click", async (event) => {
      const actionEl = event.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.getAttribute("data-action");
      if (!action) return;
      clearThreadError(threadEl);

      if (action === "reply") {
        const replyBox = body.querySelector(".grdc-thread-reply");
        if (replyBox) {
          replyBox.hidden = false;
          replyBox.querySelector("textarea")?.focus();
        }
        return;
      }

      if (action === "cancel-reply") {
        const replyBox = body.querySelector(".grdc-thread-reply");
        if (replyBox) replyBox.hidden = true;
        return;
      }

      if (action === "submit-reply") {
        const replyBox = body.querySelector(".grdc-thread-reply");
        const textarea = replyBox?.querySelector("textarea");
        const text = textarea?.value.trim() || "";
        if (!text) return;
        const replyTargetId = anchorComment.headDbId ?? anchorComment.dbId;
        if (!replyTargetId) {
          showThreadError(threadEl, "Missing review comment ID for reply.");
          return;
        }
        const reset = setButtonBusy(actionEl, "Replying...");
        try {
          const result = await replyToReviewComment(replyTargetId, text);
          if (!result.ok) throw new Error(result.error || "Reply failed.");
          const nextComments = threadResponseToComments(result.data, anchorComment.path, anchorComment.line, anchorComment.startLine);
          if (nextComments.length) upsertThreadComments(nextComments);
          else appendReplyLocally(anchorComment, { body: text });
          renderExistingComments();
          scheduleReinit(1200, true);
        } catch (error) {
          showThreadError(threadEl, error.message || "Reply failed.");
          reset();
        }
        return;
      }

      if (action === "resolve") {
        if (!anchorComment.threadNodeId) {
          showThreadError(threadEl, "Missing thread node ID for resolve.");
          return;
        }
        const reset = setButtonBusy(actionEl, "Resolving...");
        try {
          const result = await resolveReviewThread(anchorComment.threadNodeId);
          if (!result.ok) throw new Error(result.error || "Resolve failed.");
          resolveThreadLocally(anchorComment.threadId);
          renderExistingComments();
          scheduleReinit(1200, true);
        } catch (error) {
          showThreadError(threadEl, error.message || "Resolve failed.");
          reset();
        }
        return;
      }

      if (action === "delete") {
        const commentId = actionEl.getAttribute("data-comment-id");
        if (!commentId) {
          showThreadError(threadEl, "Missing review comment ID for delete.");
          return;
        }
        const reset = setButtonBusy(actionEl, "Deleting...");
        try {
          const result = await deleteReviewComment(commentId);
          if (!result.ok) throw new Error(result.error || "Delete failed.");
          removeCommentLocally(commentId);
          renderExistingComments();
          scheduleReinit(1200, true);
        } catch (error) {
          showThreadError(threadEl, error.message || "Delete failed.");
          reset();
        }
      }
    });
  }

  function renderThreadOnElement(element, threadComments) {
    if (!threadComments.length) return;
    const head = threadComments[0];
    const threadEl = createThreadElement(threadComments);
    bindThreadFocus(threadEl);
    bindThreadActions(threadEl, threadComments);
    const anchor = createInsertAnchor(element);
    const anchorLine = head.startLine != null ? head.startLine : head.line;

    let insertBefore = null;
    let probe = anchor.nextNode();
    while (probe) {
      if (probe.classList?.contains("grdc-existing-thread")) {
        const probeLine = parseLineFromAnchor(probe.dataset.grdcAnchor || "");
        if (probeLine != null && probeLine > anchorLine) {
          insertBefore = probe;
          break;
        }
      } else if (!probe.classList?.contains("grdc-existing-thread")) {
        break;
      }
      probe = probe.nextElementSibling;
    }

    anchor.insert(threadEl, insertBefore);
  }

  function renderExistingComments() {
    restoreMovedNativeThreads();
    document.querySelectorAll(".grdc-existing-thread").forEach((el) => el.remove());
    const grouped = new Map();

    existingComments.forEach((comment) => {
      const key = buildAnchorKey(comment);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(comment);
    });

    const heads = Array.from(grouped.values()).map((comments) => comments[0]);
    sortThreadHeads(heads).forEach((head) => {
      const key = buildAnchorKey(head);
      const anchorEl = findAnchorElement(head.path, head.line, head.startLine);
      if (!anchorEl) return;
      const threadComments = grouped.get(key);
      if (mountNativeThreadOnElement(anchorEl, threadComments)) return;
      renderThreadOnElement(anchorEl, threadComments);
    });
  }

  async function postReviewComment(path, line, body, opts) {
    const oids = await resolveComparisonOids(document);
    if (!prInfo || !oids.head || !oids.base) {
      return { ok: false, error: "Could not resolve PR comparison commits on this page." };
    }
    const startLine = opts?.startLine != null && opts.startLine < line ? opts.startLine : null;
    const isRange = startLine != null;
    const payload = isRange ? {
      comparisonEndOid: oids.head,
      comparisonStartOid: oids.base,
      text: body,
      submitBatch: true,
      line,
      path,
      positioning: {
        baseCommitOid: oids.base,
        headCommitOid: oids.head,
        type: "multiline",
        startPath: path,
        startLine,
        startCommitOid: oids.head,
        endPath: path,
        endLine: line,
        endCommitOid: oids.head
      },
      side: "right",
      startLine,
      startSide: "right",
      subjectType: "multiline"
    } : {
      comparisonEndOid: oids.head,
      comparisonStartOid: oids.base,
      line,
      path,
      positioning: {
        type: "line",
        baseCommitOid: oids.base,
        commitOid: oids.head,
        headCommitOid: oids.head,
        line,
        path
      },
      side: "right",
      subjectType: "line",
      submitBatch: true,
      text: body
    };

    try {
      const response = await pageFetch(
        `${prInfo.origin}/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.pullNumber}/page_data/create_review_comment`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            "GitHub-Verified-Fetch": "true"
          },
          body: JSON.stringify(payload)
        }
      );
      let data = null;
      try { data = JSON.parse(response.text); } catch (_) {}
      return { ok: true, data };
    } catch (e) {
      const message = /line could not be resolved/i.test(e.message)
        ? "Line is outside a diff hunk. Edit the line number and try again."
        : e.message;
      return { ok: false, error: message };
    }
  }

  function openCommentBox(element, info) {
    document.querySelectorAll(".grdc-comment-box").forEach((el) => el.remove());

    let lineHint = "";
    if (element.tagName === "PRE") {
      const raw = rawSourceCache.get(info.path);
      const range = raw ? findFenceRangeAroundLine(raw, info.line) : null;
      if (range) lineHint = ` <span class="grdc-line-hint">(code block, lines ${range.start}-${range.end})</span>`;
    }

    const box = document.createElement("div");
    box.className = "grdc-comment-box";
    box.innerHTML = `
      <div class="grdc-line-info">
        ${escapeHtml(info.path)} · line
        <input type="number" class="grdc-line-input" min="1" value="${info.line}">
        ${lineHint}
      </div>
      <textarea class="grdc-editor-textarea" rows="5" placeholder="Leave a comment..."></textarea>
      <div class="grdc-comment-actions">
        <button class="grdc-btn grdc-btn-cancel">Cancel</button>
        <button class="grdc-btn grdc-btn-primary">Comment</button>
      </div>
    `;

    const safe = createInsertAnchor(element);
    safe.insert(box, null);
    const textarea = box.querySelector(".grdc-editor-textarea");
    const lineInput = box.querySelector(".grdc-line-input");
    const cancelBtn = box.querySelector(".grdc-btn-cancel");
    const submitBtn = box.querySelector(".grdc-btn-primary");

    const submit = async () => {
      const body = textarea.value.trim();
      if (!body) return;
      submitBtn.disabled = true;
      submitBtn.textContent = "Posting...";
      const lineToPost = parseInt(lineInput.value, 10) || info.line;
      const result = await postReviewComment(info.path, lineToPost, body, {});
      if (result.ok) {
        const newComments = threadResponseToComments(result.data, info.path, lineToPost, null);
        const nextComments = newComments.length ? newComments : buildOptimisticComment(info.path, lineToPost, body);
        upsertThreadComments(nextComments);
        box.remove();
        renderExistingComments();
        scheduleReinit(1200, true);
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = "Comment";
        const error = document.createElement("div");
        error.className = "grdc-error";
        error.textContent = `✗ ${result.error}`;
        box.appendChild(error);
      }
    };

    cancelBtn.addEventListener("click", () => box.remove());
    submitBtn.addEventListener("click", submit);
    textarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    textarea.focus();
  }

  function scheduleReinit(delay = 250, shouldInvalidate = false) {
    if (reinitTimer) return;
    reinitTimer = setTimeout(() => {
      reinitTimer = null;
      if (shouldInvalidate) invalidateCaches();
      init();
    }, delay);
  }

  async function init() {
    const token = ++initToken;
    prInfo = parsePRUrl();
    if (!prInfo) return;
    runtimeError = "";
    viewerLogin = detectViewerLogin();

    const missingHelpers = Object.entries(requiredHelpers)
      .filter(([, value]) => typeof value !== "function")
      .map(([key]) => key);
    if (missingHelpers.length) {
      runtimeError = `Helper load failed: ${missingHelpers.join(", ")}`;
      renderHud();
      return;
    }

    invalidateCaches();
    await fetchRouteData();
    if (token !== initToken) return;
    await buildLineMap();
    if (token !== initToken) return;
    existingComments = fetchExistingComments();
    if (token !== initToken) return;

    restoreMovedNativeThreads();
    document.querySelectorAll(".grdc-existing-thread, .grdc-comment-btn, .grdc-comment-box").forEach((el) => el.remove());
    document.querySelectorAll(".grdc-hoverable").forEach((el) => el.classList.remove("grdc-hoverable"));
    attachCommentButtons();
    renderExistingComments();
    renderHud();
  }

  function maybeInit() {
    const href = window.location.href;
    if (href === lastUrl) return;
    lastUrl = href;
    scheduleReinit();
  }

  function observe() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.classList?.contains("grdc-existing-thread") || node.classList?.contains("grdc-comment-box")) continue;
          if (node.matches?.(".prose-diff, .markdown-body, .rich-diff-level-one") || node.querySelector?.(".prose-diff, .markdown-body, .rich-diff-level-one")) {
            scheduleReinit();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      maybeInit();
      observe();
      setInterval(maybeInit, POLL_MS);
    });
  } else {
    maybeInit();
    observe();
    setInterval(maybeInit, POLL_MS);
  }
})();
