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
  let pageBridgeReady = false;
  let pageBridgePromise = null;
  let pageFetchSequence = 0;
  let reinitTimer = null;
  let runtimeError = "";

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

  function ensurePageBridge() {
    if (pageBridgeReady) return Promise.resolve();
    if (pageBridgePromise) return pageBridgePromise;

    pageBridgePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page-bridge.js");
      script.async = false;
      script.onload = () => {
        pageBridgeReady = true;
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load page fetch bridge."));
      (document.head || document.documentElement).appendChild(script);
    });

    return pageBridgePromise;
  }

  async function pageFetch(url, options) {
    await ensurePageBridge();
    const requestId = `mro-${Date.now()}-${pageFetchSequence++}`;
    const request = {
      type: "MRO_PAGE_FETCH_REQUEST",
      requestId,
      url,
      method: options?.method || "GET",
      headers: options?.headers || {},
      body: typeof options?.body === "string" ? options.body : undefined
    };

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error(`Timed out while requesting ${url}`));
      }, 15000);

      function onMessage(event) {
        const data = event.data;
        if (event.source !== window || !data || data.type !== "MRO_PAGE_FETCH_RESPONSE" || data.requestId !== requestId) {
          return;
        }
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        if (!data.ok) {
          reject(new Error(data.error || `HTTP ${data.status} ${data.statusText}`.trim()));
          return;
        }
        resolve({
          ok: data.ok,
          status: data.status,
          statusText: data.statusText,
          text: data.text || ""
        });
      }

      window.addEventListener("message", onMessage);
      window.postMessage(request, "*");
    });
  }

  async function fetchText(url, acceptOrHeaders) {
    const headers = typeof acceptOrHeaders === "string" ? { Accept: acceptOrHeaders } : (acceptOrHeaders || {});
    const response = await pageFetch(url, { headers });
    return response.text;
  }

  async function fetchRouteData() {
    if (routeData || !prInfo) return routeData;

    try {
      const text = await fetchText(
        `${prInfo.origin}/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.pullNumber}/changes`,
        {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "GitHub-Verified-Fetch": "true"
        }
      );
      const data = JSON.parse(text);
      routeData = data?.payload?.pullRequestsChangesRoute || null;
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

  function getFileContainers() {
    return Array.from(document.querySelectorAll('div[id^="diff-"], [data-tagsearch-path], .file[data-path], .file'));
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
      const match = href.match(/\/blob\/[0-9a-f]{40}\/(.+)$/i);
      if (match) return decodeURIComponent(match[1]);
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

  function discoverCommitOids(container) {
    const oids = { head: null, base: null };
    const blobLink = (container || document).querySelector('a[href*="/blob/"]');
    if (blobLink) {
      const m = blobLink.getAttribute("href").match(/\/blob\/([0-9a-f]{40})\//);
      if (m) oids.head = m[1];
    }

    for (const script of document.querySelectorAll('script[type="application/json"], script')) {
      const text = script.textContent || "";
      if (!oids.head) {
        const m = text.match(/"head[_A-Za-z]*[Oo]id"\s*:\s*"([0-9a-f]{40})"/);
        if (m) oids.head = m[1];
      }
      if (!oids.base) {
        const m = text.match(/"(?:base|merge_base|comparisonStart)[_A-Za-z]*[Oo]id"\s*:\s*"([0-9a-f]{40})"/);
        if (m) oids.base = m[1];
      }
      if (oids.head && oids.base) break;
    }

    if (routeData?.comparison?.fullDiff?.headOid) oids.head = routeData.comparison.fullDiff.headOid;
    if (routeData?.comparison?.fullDiff?.baseOid) oids.base = routeData.comparison.fullDiff.baseOid;
    if (routeData?.comparison?.fullDiff?.comparisonStartOid) oids.base = routeData.comparison.fullDiff.comparisonStartOid;
    return oids;
  }

  async function fetchRawSource(container, path) {
    if (rawSourceCache.has(path)) return rawSourceCache.get(path);

    const oids = discoverCommitOids(container);
    if (!oids.head || !prInfo || !looksLikePath(path)) return null;

    try {
      const blobUrl = `${prInfo.origin}/${prInfo.owner}/${prInfo.repo}/blob/${oids.head}/${encodeURI(path)}`;
      const html = await fetchText(blobUrl, "text/html,*/*");

      let m = html.match(/<textarea[^>]*id=["']read-only-cursor-text-area["'][^>]*>([\s\S]*?)<\/textarea>/);
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
      console.log("[MRO] Blob HTML error for", path, e.message);
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
      if (container.querySelector("[data-line-number], .blob-num")) continue;
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

  function renderHud() {
    document.querySelectorAll(`.${EXT}-hud`).forEach((el) => el.remove());
    const containers = getFileContainers();
    const markdownFiles = containers.map(getFilePath).filter(isMarkdownPath).length;
    const richDiffFiles = containers.filter((c) => {
      const path = getFilePath(c);
      return isMarkdownPath(path) && !!getRichDiff(c);
    }).length;
    const commentableBlocks = fileLineMap.size;
    const routeFiles = routeData?.diffSummaries?.length || 0;
    const note = runtimeError || (richDiffFiles === 0
      ? "Rich Diff を開いたあとに Reload / Rescan を押してください。"
      : commentableBlocks === 0
        ? "Rich Diff は読めていますが、行マッピングがまだ作れていません。対象 markdown の raw 取得を再試行してください。"
        : "既存スレッドはライン順に配置し、新規コメントは同じ位置へ挿入されます。");
    const hud = document.createElement("aside");
    hud.className = `${EXT}-hud`;
    hud.innerHTML = `
      <div class="${EXT}-hud-top">
        <div>
          <div class="${EXT}-hud-eyebrow">Markdown Review Overlay</div>
          <div class="${EXT}-hud-title">${safeEscapeHtml(window.location.host)}</div>
        </div>
        <div class="${EXT}-hud-controls">
          <button type="button" class="${EXT}-hud-action">Reload / Rescan</button>
        </div>
      </div>
      <div class="${EXT}-hud-body">
        <div class="${EXT}-hud-grid">
          <div class="${EXT}-hud-stat"><strong>${routeFiles}</strong><span>Route files</span></div>
          <div class="${EXT}-hud-stat"><strong>${markdownFiles}</strong><span>Markdown files</span></div>
          <div class="${EXT}-hud-stat"><strong>${richDiffFiles}</strong><span>Rich diff files</span></div>
          <div class="${EXT}-hud-stat"><strong>${commentableBlocks}</strong><span>Commentable blocks</span></div>
        </div>
        <div class="${EXT}-hud-note">${safeEscapeHtml(note)}</div>
      </div>
    `;
    hud.querySelector(`.${EXT}-hud-action`).addEventListener("click", () => {
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
          isResolved: !!thread?.isResolved,
          isOutdated: !!(thread?.isOutdated || thread?.outdated),
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

  function createThreadElement(headComments) {
    const head = headComments[0];
    const wrap = document.createElement("div");
    wrap.className = "grdc-existing-thread";
    wrap.dataset.grdcAnchor = buildAnchorKey(head);
    wrap.innerHTML = `
      <button type="button" class="grdc-thread-badge">💬 ${headComments.length} comment${headComments.length > 1 ? "s" : ""}</button>
      <div class="grdc-thread-body" style="display:none;"></div>
    `;
    const badge = wrap.querySelector(".grdc-thread-badge");
    const body = wrap.querySelector(".grdc-thread-body");

    body.innerHTML = headComments.map((comment) => `
      <div class="grdc-thread-comment">
        <div class="grdc-thread-meta">
          <strong>${escapeHtml(comment.user)}</strong>
          <span>${escapeHtml(formatTimeAgo(comment.createdAt))}</span>
        </div>
        <div class="grdc-thread-text">${comment.bodyHTML || escapeHtml(comment.body).replace(/\n/g, "<br>")}</div>
      </div>
    `).join("");

    badge.addEventListener("click", () => {
      body.style.display = body.style.display === "none" ? "block" : "none";
    });
    return wrap;
  }

  function renderThreadOnElement(element, threadComments) {
    if (!threadComments.length) return;
    const head = threadComments[0];
    const threadEl = createThreadElement(threadComments);
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
      renderThreadOnElement(anchorEl, grouped.get(key));
    });
  }

  async function postReviewComment(path, line, body, opts) {
    const oids = discoverCommitOids(document);
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
            Accept: "application/json",
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
        if (newComments.length) renderThreadOnElement(element, newComments);
        box.remove();
        scheduleReinit();
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

  function scheduleReinit() {
    if (reinitTimer) return;
    reinitTimer = setTimeout(() => {
      reinitTimer = null;
      init();
    }, 250);
  }

  async function init() {
    const token = ++initToken;
    prInfo = parsePRUrl();
    if (!prInfo) return;
    runtimeError = "";

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
