(function bootstrapPopup(global) {
  var Shared = global.ItStepShared;
  var scanButton = document.getElementById("scan-button");
  var htmlButton = document.getElementById("html-button");
  var zipButton = document.getElementById("zip-button");
  var pageStatus = document.getElementById("page-status");
  var summaryText = document.getElementById("summary-text");
  var statusPill = document.getElementById("status-pill");
  var countBadge = document.getElementById("count-badge");
  var emptyState = document.getElementById("empty-state");
  var itemsList = document.getElementById("items-list");
  var errorsSection = document.getElementById("errors-section");
  var errorsList = document.getElementById("errors-list");

  var currentSnapshot = null;
  var localBusy = false;
  var pollTimer = null;
  var flashMessage = "";
  var flashUntil = 0;

  scanButton.addEventListener("click", function onScanClick() {
    void runAction(Shared.ACTIONS.SCAN_CURRENT_PAGE);
  });

  htmlButton.addEventListener("click", function onHtmlClick() {
    void runAction(Shared.ACTIONS.DOWNLOAD_HTML_INDEX);
  });

  zipButton.addEventListener("click", function onZipClick() {
    void runAction(Shared.ACTIONS.DOWNLOAD_ZIP);
  });

  chrome.runtime.onMessage.addListener(function onMessage(message) {
    if (!message || message.action !== Shared.ACTIONS.JOB_STATE_UPDATED) {
      return;
    }

    currentSnapshot = message.jobState;
    render();
  });

  void refreshState();

  async function refreshState() {
    var response = await chrome.runtime.sendMessage({
      action: Shared.ACTIONS.GET_JOB_STATE
    });

    if (!response || !response.ok) {
      pageStatus.textContent = response && response.error || "Nepodařilo se načíst stav rozšíření.";
      return;
    }

    currentSnapshot = response.jobState;
    render();
  }

  async function runAction(action) {
    if (!currentSnapshot || !currentSnapshot.pageSupported) {
      return;
    }

    localBusy = true;
    render();

    try {
      var response = await chrome.runtime.sendMessage({
        action: action
      });

      if (!response || !response.ok) {
        throw new Error(response && response.error || "Akce selhala.");
      }

      if (response.jobState) {
        currentSnapshot = response.jobState;
      }

      if (action === Shared.ACTIONS.DOWNLOAD_HTML_INDEX) {
        setFlashMessage("HTML index byl odeslán do stahování.");
      } else if (action === Shared.ACTIONS.DOWNLOAD_ZIP) {
        setFlashMessage("ZIP archiv byl odeslán do stahování.");
      }
    } catch (error) {
      setFlashMessage(Shared.serializeError(error));
    } finally {
      localBusy = false;
      render();
      await refreshState();
    }
  }

  function render() {
    if (!currentSnapshot) {
      return;
    }

    var jobState = currentSnapshot.jobState;
    var pageSupported = currentSnapshot.pageSupported;
    var result = jobState.result;
    var items = result && Array.isArray(result.items) ? result.items : [];
    var errors = result && Array.isArray(result.errors) ? result.errors : [];

    pageStatus.textContent = pageSupported
      ? "Aktivní tab je připravený pro sběr z /materials."
      : "Popup funguje jen nad aktivní stránkou https://lb.itstep.org/materials.";

    var pillClass = "status-pill--idle";
    var pillText = "Připraveno";

    if (jobState.status === Shared.JOB_STATUS.RUNNING) {
      pillClass = "status-pill--running";
      pillText = "Probíhá sběr";
      startPolling();
    } else if (jobState.status === Shared.JOB_STATUS.COMPLETED) {
      pillClass = "status-pill--completed";
      pillText = "Dokončeno";
      stopPolling();
    } else if (jobState.status === Shared.JOB_STATUS.ERROR) {
      pillClass = "status-pill--error";
      pillText = "Chyba";
      stopPolling();
    } else {
      stopPolling();
    }

    statusPill.className = "status-pill " + pillClass;
    statusPill.textContent = pillText;

    if (Date.now() < flashUntil && flashMessage) {
      summaryText.textContent = flashMessage;
    } else if (jobState.status === Shared.JOB_STATUS.RUNNING) {
      summaryText.textContent = jobState.progress.message + " (" + jobState.progress.current + " / " + jobState.progress.total + ")";
    } else if (jobState.status === Shared.JOB_STATUS.ERROR) {
      summaryText.textContent = jobState.errorMessage || "Poslední běh skončil chybou.";
    } else if (jobState.status === Shared.JOB_STATUS.COMPLETED) {
      summaryText.textContent = "Nalezeno " + items.length + " přímých odkazů z celkem " + jobState.progress.total + " čipů.";
    } else {
      summaryText.textContent = "Po otevření popupu se zobrazí poslední stav skenování.";
    }

    countBadge.textContent = String(items.length);

    renderItems(items);
    renderErrors(errors);

    var isRunning = jobState.status === Shared.JOB_STATUS.RUNNING;
    scanButton.disabled = !pageSupported || isRunning || localBusy;
    htmlButton.disabled = !pageSupported || !items.length || isRunning || localBusy;
    zipButton.disabled = !pageSupported || !items.length || isRunning || localBusy;
  }

  function renderItems(items) {
    itemsList.textContent = "";

    if (!items.length) {
      emptyState.hidden = false;
      itemsList.hidden = true;
      return;
    }

    emptyState.hidden = true;
    itemsList.hidden = false;

    items.forEach(function eachItem(item) {
      var listItem = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "item-button";
      button.innerHTML = [
        "<span class=\"item-button__title\">" + Shared.escapeHtml(item.chipLabel) + "</span>",
        "<span class=\"item-button__meta\">" + Shared.escapeHtml(item.rowNumber + " · " + item.columnTitle + " · " + item.materialType) + "</span>"
      ].join("");
      button.addEventListener("click", function onItemClick() {
        void chrome.runtime.sendMessage({
          action: Shared.ACTIONS.OPEN_FILE,
          url: item.fileUrl
        });
      });
      listItem.appendChild(button);
      itemsList.appendChild(listItem);
    });
  }

  function renderErrors(errors) {
    errorsList.textContent = "";

    if (!errors.length) {
      errorsSection.hidden = true;
      return;
    }

    errorsSection.hidden = false;
    errors.forEach(function eachError(error) {
      var item = document.createElement("li");
      item.textContent = (error.rowNumber ? error.rowNumber + " / " : "") + (error.chipLabel || error.itemId || "Položka") + ": " + error.message;
      errorsList.appendChild(item);
    });
  }

  function startPolling() {
    if (pollTimer) {
      return;
    }

    pollTimer = setInterval(function pollState() {
      void refreshState();
    }, 1200);
  }

  function stopPolling() {
    if (!pollTimer) {
      return;
    }

    clearInterval(pollTimer);
    pollTimer = null;
  }

  function setFlashMessage(message) {
    flashMessage = message;
    flashUntil = Date.now() + 4000;
  }
})(globalThis);
