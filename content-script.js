(function bootstrapContentScript(global) {
  if (global.__itStepMaterialsContentScriptLoaded) {
    return;
  }

  global.__itStepMaterialsContentScriptLoaded = true;
  var Shared = global.ItStepShared;
  var scanLock = false;

  chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
    if (!message || message.action !== Shared.ACTIONS.COLLECT_MATERIALS) {
      return undefined;
    }

    collectMaterials()
      .then(function onSuccess(result) {
        sendResponse({
          ok: true,
          result: result
        });
      })
      .catch(function onFailure(error) {
        sendResponse({
          ok: false,
          error: Shared.serializeError(error)
        });
      });

    return true;
  });

  async function collectMaterials() {
    if (scanLock) {
      throw new Error("Sběr už běží v této stránce.");
    }

    if (!Shared.isSupportedMaterialsUrl(global.location.href)) {
      throw new Error("Tato stránka není podporovaná pro sběr materiálů.");
    }

    scanLock = true;
    var overlay = createOverlay();
    var errors = [];

    try {
      var collectedItems = extractTableItems();
      Shared.debugLog("content:scan:start", {
        url: global.location.href,
        count: collectedItems.length
      });
      if (!collectedItems.length) {
        throw new Error("Na stránce nebyly nalezeny žádné materiály.");
      }

      await sendProgress(0, collectedItems.length, "Nalezeny položky, začínám otevírat modaly.");

      for (var index = 0; index < collectedItems.length; index += 1) {
        var item = collectedItems[index];
        var progressLabel = item.rowNumber + " / " + item.columnTitle + " / " + item.chipLabel;
        updateOverlay(overlay, index, collectedItems.length, progressLabel);
        await sendProgress(index, collectedItems.length, "Zpracovávám " + progressLabel);

        try {
          await closeDialogIfOpen();
          await openChipModal(item._chip);
          var fileUrl = await readFileUrlFromModal();

          if (!Shared.isFsxFileUrl(fileUrl)) {
            throw new Error("V modalu nebyl nalezen platný FSX odkaz.");
          }

          item.fileUrl = fileUrl;
          Shared.debugLog("content:item:resolved", item.id, fileUrl);
        } catch (error) {
          Shared.debugLog("content:item:error", item.id, Shared.serializeError(error));
          errors.push({
            itemId: item.id,
            rowNumber: item.rowNumber,
            columnTitle: item.columnTitle,
            chipLabel: item.chipLabel,
            message: Shared.serializeError(error)
          });
        } finally {
          await closeDialogIfOpen();
        }
      }

      updateOverlay(overlay, collectedItems.length, collectedItems.length, "Sběr dokončen.");
      await sendProgress(collectedItems.length, collectedItems.length, "Sběr dokončen.");
      Shared.debugLog("content:scan:done", {
        resolved: collectedItems.filter(function hasUrl(entry) {
          return Boolean(entry.fileUrl);
        }).length,
        errors: errors.length
      });

      return {
        items: collectedItems.map(function stripDomRefs(item) {
          return {
            id: item.id,
            rowNumber: item.rowNumber,
            rowTitle: item.rowTitle,
            columnTitle: item.columnTitle,
            chipLabel: item.chipLabel,
            materialType: item.materialType,
            fileUrl: item.fileUrl || "",
            sourceUrl: global.location.href
          };
        }).filter(function filterResolved(item) {
          return Boolean(item.fileUrl);
        }),
        errors: errors,
        scannedCount: collectedItems.length
      };
    } finally {
      overlay.remove();
      scanLock = false;
    }
  }

  function extractTableItems() {
    var table = document.querySelector("table.mat-mdc-table");
    if (!table) {
      throw new Error("Nepodařilo se najít tabulku materiálů.");
    }

    var headers = Array.from(table.querySelectorAll("tr[mat-header-row] th, thead tr th")).map(function mapHeader(cell) {
      return Shared.normalizeText(cell.innerText || cell.textContent || "");
    });

    var rows = Array.from(table.querySelectorAll("tbody tr[mat-row], tbody tr.mat-mdc-row"));
    var collected = [];

    rows.forEach(function eachRow(row, rowIndex) {
      var cells = Array.from(row.querySelectorAll(":scope > td"));
      if (cells.length < 3) {
        return;
      }

      var rowNumber = Shared.normalizeText(cells[0].innerText || cells[0].textContent || "") || String(rowIndex + 1);
      var rowTitle = Shared.normalizeText(cells[1].innerText || cells[1].textContent || "");

      for (var cellIndex = 2; cellIndex < cells.length; cellIndex += 1) {
        var columnTitle = headers[cellIndex] || ("Sloupec-" + (cellIndex - 1));
        var chips = Array.from(cells[cellIndex].querySelectorAll("mat-chip"));
        chips.forEach(function eachChip(chip) {
          var chipLabel = Shared.normalizeText(chip.innerText || chip.textContent || "");
          if (!chipLabel) {
            return;
          }

          var nextIndex = collected.length + 1;
          collected.push({
            id: Shared.buildItemId({
              rowNumber: rowNumber,
              columnTitle: columnTitle,
              chipLabel: chipLabel
            }, nextIndex),
            rowNumber: rowNumber,
            rowTitle: rowTitle,
            columnTitle: columnTitle,
            chipLabel: chipLabel,
            materialType: detectMaterialType(chip),
            fileUrl: "",
            _chip: chip
          });
        });
      }
    });

    return collected;
  }

  function detectMaterialType(chip) {
    var inlineColor = chip.style.getPropertyValue("--mdc-chip-elevated-container-color");
    var computedStyles = global.getComputedStyle(chip);
    var cssVariable = computedStyles.getPropertyValue("--mdc-chip-elevated-container-color");
    var backgroundColor = computedStyles.backgroundColor;
    return Shared.materialTypeFromColor(inlineColor)
      || Shared.materialTypeFromColor(cssVariable)
      || Shared.materialTypeFromColor(backgroundColor)
      || Shared.MATERIAL_TYPES.BASE;
  }

  async function openChipModal(chip) {
    chip.scrollIntoView({
      behavior: "instant",
      block: "center"
    });
    chip.click();
    await waitFor(function modalOpen() {
      return document.querySelector("mat-dialog-container");
    }, 6000, "Nepodařilo se otevřít modal s materiálem.");
    await Shared.delay(100);
  }

  async function readFileUrlFromModal() {
    var dialog = await waitFor(function getDialog() {
      return document.querySelector("mat-dialog-container");
    }, 6000, "Modal nebyl nalezen.");

    var anchor = await waitFor(function getAnchor() {
      return dialog.querySelector('a[href*="fsx1.itstep.org/api/v1/files/"]');
    }, 6000, "V modalu chybí odkaz na soubor.");

    var href = anchor.getAttribute("href") || "";
    if (Shared.isFsxFileUrl(href)) {
      return href;
    }

    var iframe = dialog.querySelector('iframe[src*="fsx1.itstep.org/api/v1/files/"]');
    if (!iframe) {
      return "";
    }

    var source = iframe.getAttribute("src") || "";
    if (source.includes("?inline")) {
      return source.replace("?inline", "?inline=true");
    }
    return source;
  }

async function closeDialogIfOpen() {
  var dialog = document.querySelector("mat-dialog-container");
  if (!dialog) {
    return;
  }

  var backdrop = document.querySelector(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  if (backdrop) {
    backdrop.click();
  }

  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true
  }));

  await waitFor(function dialogClosed() {
    return !document.querySelector("mat-dialog-container");
  }, 5000, "Nepodařilo se zavřít modal.");
    await Shared.delay(100);
  }

  function waitFor(predicate, timeoutMs, errorMessage) {
    var timeout = Number(timeoutMs || 5000);
    var start = Date.now();

    return new Promise(function wait(resolve, reject) {
      function check() {
        try {
          var value = predicate();
          if (value) {
            resolve(value);
            return;
          }
        } catch (error) {
          reject(error);
          return;
        }

        if (Date.now() - start >= timeout) {
          reject(new Error(errorMessage || "Timeout while waiting for DOM state."));
          return;
        }

        setTimeout(check, 100);
      }

      check();
    });
  }

  async function sendProgress(current, total, message) {
    try {
      await chrome.runtime.sendMessage({
        action: Shared.ACTIONS.SCAN_PROGRESS,
        current: current,
        total: total,
        message: message
      });
    } catch (error) {
      return undefined;
    }
  }

  function createOverlay() {
    var overlay = document.createElement("div");
    overlay.id = "it-step-materials-overlay";
    overlay.setAttribute("style", [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "min-width:260px",
      "max-width:360px",
      "padding:14px 16px",
      "border-radius:14px",
      "background:rgba(17,24,39,0.92)",
      "color:#f8fafc",
      "font:13px/1.45 'Segoe UI Variable Text','Bahnschrift',sans-serif",
      "box-shadow:0 16px 40px rgba(2,8,23,0.35)"
    ].join(";"));

    overlay.innerHTML = [
      '<div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;margin-bottom:6px;">IT Step Materials</div>',
      '<div id="it-step-materials-overlay-text">Připravuji sběr...</div>'
    ].join("");

    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function updateOverlay(overlay, current, total, message) {
    var textNode = overlay.querySelector("#it-step-materials-overlay-text");
    if (!textNode) {
      return;
    }

    var prefix = total ? (current + 1 > total ? total : current + 1) + " / " + total + " · " : "";
    textNode.textContent = prefix + message;
  }
})(globalThis);
