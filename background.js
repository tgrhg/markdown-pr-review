chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "MRO_BACKGROUND_FETCH") return;

  (async () => {
    try {
      const response = await fetch(message.url, {
        method: message.method || "GET",
        headers: message.headers || undefined,
        body: message.body || undefined,
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
