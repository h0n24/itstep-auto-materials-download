importScripts("shared.js");

var Shared = globalThis.ItStepShared;
var jobStateCache = null;
var runningScanPromise = null;
var offscreenPromise = null;

chrome.runtime.onInstalled.addListener(function onInstalled() {
  void loadJobState();
});

chrome.runtime.onStartup.addListener(function onStartup() {
  void loadJobState();
});

chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
  if (!message || !message.action || !isBackgroundAction(message.action)) {
    return undefined;
  }

  handleMessage(message, sender)
    .then(function onSuccess(result) {
      sendResponse(result);
    })
    .catch(function onFailure(error) {
      sendResponse({
        ok: false,
        error: Shared.serializeError(error)
      });
    });

  return true;
});

function createDefaultJobState() {
  return {
    status: Shared.JOB_STATUS.IDLE,
    activeTabId: null,
    activeTabUrl: "",
    startedAt: "",
    finishedAt: "",
    updatedAt: "",
    progress: {
      current: 0,
      total: 0,
      message: "Připraveno."
    },
    result: null,
    resultsByUrl: {},
    errorMessage: ""
  };
}

async function loadJobState() {
  if (jobStateCache) {
    return jobStateCache;
  }

  var stored = await chrome.storage.session.get(Shared.STORAGE_KEYS.JOB_STATE);
  jobStateCache = stored[Shared.STORAGE_KEYS.JOB_STATE] || createDefaultJobState();
  return jobStateCache;
}

async function saveJobState(nextState) {
  jobStateCache = Object.assign({}, nextState, {
    updatedAt: new Date().toISOString()
  });

  await chrome.storage.session.set({
    [Shared.STORAGE_KEYS.JOB_STATE]: jobStateCache
  });

  await broadcastJobState();
  return jobStateCache;
}

async function patchJobState(partialState) {
  var currentState = await loadJobState();
  return saveJobState(Object.assign({}, currentState, partialState));
}

async function broadcastJobState() {
  var payload = await buildPopupState();
  try {
    await chrome.runtime.sendMessage({
      action: Shared.ACTIONS.JOB_STATE_UPDATED,
      jobState: payload
    });
  } catch (error) {
    if (!String(error && error.message || "").includes("Receiving end does not exist")) {
      throw error;
    }
  }
}

async function handleMessage(message, sender) {
  Shared.debugLog("background:message", message.action, sender && sender.tab && sender.tab.id);
  switch (message.action) {
    case Shared.ACTIONS.GET_JOB_STATE:
      return {
        ok: true,
        jobState: await buildPopupState()
      };
    case Shared.ACTIONS.SCAN_CURRENT_PAGE:
      return startScan();
    case Shared.ACTIONS.DOWNLOAD_HTML_INDEX:
      return downloadExport(Shared.ACTIONS.OFFSCREEN_DOWNLOAD_HTML);
    case Shared.ACTIONS.DOWNLOAD_ZIP:
      return downloadExport(Shared.ACTIONS.OFFSCREEN_DOWNLOAD_ZIP);
    case Shared.ACTIONS.OPEN_FILE:
      return openFileInTab(message.url);
    case Shared.ACTIONS.SCAN_PROGRESS:
      return handleScanProgress(message, sender);
    default:
      return {
        ok: false,
        error: "Unsupported action."
      };
  }
}

async function buildPopupState() {
  var activeTab = await getActiveTab();
  var jobState = await loadJobState();
  var activeTabUrl = activeTab && activeTab.url || "";
  var hasCachedResult = Boolean(
    activeTabUrl
    && jobState.resultsByUrl
    && Object.prototype.hasOwnProperty.call(jobState.resultsByUrl, activeTabUrl)
  );
  var cachedResult = hasCachedResult ? jobState.resultsByUrl[activeTabUrl] : null;
  var resolvedState = Object.assign({}, jobState, {
    result: hasCachedResult
      ? cachedResult
      : (activeTabUrl && activeTabUrl === jobState.activeTabUrl ? jobState.result : null)
  });
  return {
    activeTabId: activeTab && activeTab.id || null,
    activeTabUrl: activeTabUrl,
    pageSupported: Boolean(activeTab && Shared.isSupportedMaterialsUrl(activeTabUrl)),
    jobState: resolvedState
  };
}

async function getActiveTab() {
  var tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  return tabs[0] || null;
}

async function ensureMaterialsTab() {
  var activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id || !Shared.isSupportedMaterialsUrl(activeTab.url || "")) {
    throw new Error("Aktivní tab není podporovaná stránka https://lb.itstep.org/materials.");
  }
  return activeTab;
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: {
      tabId: tabId
    },
    files: ["shared.js", "content-script.js"]
  });
}

async function startScan() {
  if (runningScanPromise) {
    return {
      ok: false,
      error: "Sběr už právě běží.",
      jobState: await buildPopupState()
    };
  }

  var activeTab = await ensureMaterialsTab();
  var stateBeforeScan = await loadJobState();
  await saveJobState({
    resultsByUrl: Object.assign({}, stateBeforeScan.resultsByUrl || {}, {
      [activeTab.url || ""]: null
    }),
    status: Shared.JOB_STATUS.RUNNING,
    activeTabId: activeTab.id,
    activeTabUrl: activeTab.url || "",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    progress: {
      current: 0,
      total: 0,
      message: "Spouštím sběr odkazů..."
    },
    result: null,
    errorMessage: ""
  });

  runningScanPromise = (async function runScan() {
    try {
      Shared.debugLog("background:scan:start", activeTab.url);
      await ensureContentScript(activeTab.id);
      var response = await chrome.tabs.sendMessage(activeTab.id, {
        action: Shared.ACTIONS.COLLECT_MATERIALS
      });

      if (!response || !response.ok) {
        throw new Error(response && response.error || "Content script nevrátil validní odpověď.");
      }

      var currentState = await loadJobState();
      var resultsByUrl = Object.assign({}, currentState.resultsByUrl || {}, {
        [activeTab.url || ""]: response.result
      });

      await patchJobState({
        status: Shared.JOB_STATUS.COMPLETED,
        finishedAt: new Date().toISOString(),
        progress: {
          current: response.result.scannedCount,
          total: response.result.scannedCount,
          message: "Sběr odkazů dokončen."
        },
        result: response.result,
        resultsByUrl: resultsByUrl,
        errorMessage: ""
      });
      Shared.debugLog("background:scan:done", {
        url: activeTab.url,
        items: response.result.items.length,
        errors: response.result.errors.length
      });

      return {
        ok: true,
        jobState: await buildPopupState()
      };
    } catch (error) {
      Shared.debugLog("background:scan:error", Shared.serializeError(error));
      await patchJobState({
        status: Shared.JOB_STATUS.ERROR,
        finishedAt: new Date().toISOString(),
        progress: {
          current: 0,
          total: 0,
          message: "Sběr odkazů selhal."
        },
        errorMessage: Shared.serializeError(error)
      });

      return {
        ok: false,
        error: Shared.serializeError(error),
        jobState: await buildPopupState()
      };
    } finally {
      runningScanPromise = null;
    }
  })();

  return runningScanPromise;
}

async function handleScanProgress(message, sender) {
  var state = await loadJobState();
  if (state.status !== Shared.JOB_STATUS.RUNNING) {
    return { ok: true };
  }

  if (sender.tab && state.activeTabId && sender.tab.id !== state.activeTabId) {
    return { ok: true };
  }

  await patchJobState({
    progress: {
      current: Number(message.current || 0),
      total: Number(message.total || 0),
      message: String(message.message || "Probíhá sběr...")
    }
  });

  return { ok: true };
}

async function openFileInTab(url) {
  if (!Shared.isFsxFileUrl(url)) {
    throw new Error("Neplatný odkaz na soubor.");
  }

  await chrome.tabs.create({
    url: url
  });

  return { ok: true };
}

async function ensureResultForExport() {
  var activeTab = await ensureMaterialsTab();
  var state = await loadJobState();
  var hasCachedResult = Boolean(
    activeTab.url
    && state.resultsByUrl
    && Object.prototype.hasOwnProperty.call(state.resultsByUrl, activeTab.url)
  );
  var resolvedResult = hasCachedResult
    ? state.resultsByUrl[activeTab.url]
    : (activeTab.url && activeTab.url === state.activeTabUrl ? state.result : null);
  if (state.status !== Shared.JOB_STATUS.COMPLETED || !resolvedResult || !Array.isArray(resolvedResult.items) || !resolvedResult.items.length) {
    throw new Error("Nejprve načtěte seznam odkazů.");
  }
  return resolvedResult;
}

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    var offscreenUrl = chrome.runtime.getURL("offscreen.html");
    var contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });

    if (contexts.length) {
      return;
    }
  }

  if (!offscreenPromise) {
    offscreenPromise = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Generate HTML index and ZIP downloads for IT Step materials."
    }).catch(function handleDuplicateDocument(error) {
      var message = Shared.serializeError(error);
      if (!message.includes("Only a single offscreen")) {
        throw error;
      }
    }).finally(function releasePromise() {
      offscreenPromise = null;
    });
  }

  await offscreenPromise;
}

async function downloadExport(offscreenAction) {
  var result = await ensureResultForExport();
  await ensureOffscreenDocument();
  Shared.debugLog("background:export:start", offscreenAction, result.items.length);

  var response = await chrome.runtime.sendMessage({
    action: offscreenAction,
    payload: {
      items: result.items,
      errors: result.errors || [],
      scannedCount: result.scannedCount || result.items.length,
      generatedAt: new Date().toISOString()
    }
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error || "Offscreen export selhal.");
  }

  if (!chrome.downloads || !chrome.downloads.download) {
    throw new Error("Chrome downloads API není v background service workeru dostupné.");
  }

  var downloadId = await chrome.downloads.download({
    url: response.downloadUrl,
    filename: response.fileName,
    saveAs: false
  });
  Shared.debugLog("background:export:done", offscreenAction, downloadId, response.fileName);

  return {
    ok: true,
    downloadId: downloadId,
    failedCount: response.failedCount || 0
  };
}

function isBackgroundAction(action) {
  return action === Shared.ACTIONS.GET_JOB_STATE
    || action === Shared.ACTIONS.SCAN_CURRENT_PAGE
    || action === Shared.ACTIONS.DOWNLOAD_HTML_INDEX
    || action === Shared.ACTIONS.DOWNLOAD_ZIP
    || action === Shared.ACTIONS.OPEN_FILE
    || action === Shared.ACTIONS.SCAN_PROGRESS;
}
