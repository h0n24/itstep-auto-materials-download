(function bootstrapOffscreen(global) {
  var Shared = global.ItStepShared;
  var ZipBuilder = global.ItStepZipBuilder;

  chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
    if (!message || !message.action) {
      return undefined;
    }

    handleMessage(message)
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

  async function handleMessage(message) {
    switch (message.action) {
      case Shared.ACTIONS.OFFSCREEN_DOWNLOAD_HTML:
        return downloadHtmlIndex(message.payload);
      case Shared.ACTIONS.OFFSCREEN_DOWNLOAD_ZIP:
        return downloadZipArchive(message.payload);
      default:
        return {
          ok: false,
          error: "Unsupported offscreen action."
        };
    }
  }

  async function downloadHtmlIndex(payload) {
    var html = buildHtmlIndex(payload);
    var blob = new Blob([html], {
      type: "text/html;charset=utf-8"
    });
    var fileName = "itstep-materials-index_" + Shared.formatTimestampForFile(payload.generatedAt) + ".html";
    var downloadId = await triggerDownload(blob, fileName);
    return {
      ok: true,
      downloadId: downloadId
    };
  }

  async function downloadZipArchive(payload) {
    var zip = new ZipBuilder();
    var usedPaths = new Set();
    var downloadReport = [];
    var exportErrors = [];

    for (var index = 0; index < payload.items.length; index += 1) {
      var item = payload.items[index];
      try {
        var response = await fetch(item.fileUrl, {
          credentials: "include"
        });
        if (!response.ok) {
          throw new Error("HTTP " + response.status + " " + response.statusText);
        }

        var contentDisposition = response.headers.get("content-disposition");
        var contentType = response.headers.get("content-type");
        var serverName = Shared.parseFilenameFromContentDisposition(contentDisposition);
        var extension = Shared.extensionFromFileName(serverName) || Shared.extensionFromContentType(contentType) || "";
        var baseName = Shared.buildBaseFileName(item);
        var filePath = ensureUniqueZipPath(usedPaths, item.materialType + "/" + baseName + extension);
        var fileBytes = new Uint8Array(await response.arrayBuffer());
        zip.addFile(filePath, fileBytes, new Date());
        downloadReport.push({
          id: item.id,
          path: filePath,
          status: "downloaded",
          contentType: contentType || ""
        });
      } catch (error) {
        var serializedError = Shared.serializeError(error);
        exportErrors.push({
          id: item.id,
          fileUrl: item.fileUrl,
          message: serializedError
        });
        downloadReport.push({
          id: item.id,
          path: "",
          status: "failed",
          message: serializedError
        });
      }
    }

    zip.addText("export-report.json", JSON.stringify({
      generatedAt: payload.generatedAt,
      scannedCount: payload.scannedCount,
      sourceErrors: payload.errors || [],
      downloadResults: downloadReport,
      downloadErrors: exportErrors
    }, null, 2));

    var zipBlob = zip.build();
    var fileName = "itstep-materials_" + Shared.formatTimestampForFile(payload.generatedAt) + ".zip";
    var downloadId = await triggerDownload(zipBlob, fileName);
    return {
      ok: true,
      downloadId: downloadId,
      failedCount: exportErrors.length
    };
  }

  function buildHtmlIndex(payload) {
    var rows = payload.items.map(function mapItem(item) {
      return [
        "<tr>",
        "<td>" + Shared.escapeHtml(item.rowNumber) + "</td>",
        "<td>" + Shared.escapeHtml(item.rowTitle) + "</td>",
        "<td>" + Shared.escapeHtml(item.columnTitle) + "</td>",
        "<td>" + Shared.escapeHtml(item.chipLabel) + "</td>",
        "<td>" + Shared.escapeHtml(item.materialType) + "</td>",
        "<td><a href=\"" + Shared.escapeHtml(item.fileUrl) + "\" target=\"_blank\" rel=\"noreferrer\">Otevřít soubor</a></td>",
        "</tr>"
      ].join("");
    }).join("");

    var errors = (payload.errors || []).map(function mapError(error) {
      return "<li><strong>" + Shared.escapeHtml(error.itemId || "unknown") + "</strong>: " + Shared.escapeHtml(error.message) + "</li>";
    }).join("");

    return [
      "<!doctype html>",
      "<html lang=\"cs\">",
      "<head>",
      "<meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
      "<title>IT Step Materials Index</title>",
      "<style>",
      "body{margin:0;padding:32px;background:#f5f7fb;color:#0f172a;font:15px/1.55 'Segoe UI Variable Text','Bahnschrift',sans-serif}",
      ".shell{max-width:1200px;margin:0 auto;background:#fff;border-radius:24px;padding:28px 30px;box-shadow:0 20px 48px rgba(15,23,42,.08)}",
      "h1{margin:0 0 8px;font-size:28px}",
      ".meta{color:#475569;margin:0 0 24px}",
      "table{width:100%;border-collapse:collapse;background:#fff}",
      "th,td{padding:12px 10px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}",
      "th{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#64748b}",
      "a{color:#0369a1;text-decoration:none}",
      "a:hover{text-decoration:underline}",
      ".errors{margin-top:28px;padding:18px;border-radius:18px;background:#fff7ed}",
      ".errors h2{margin:0 0 10px;font-size:18px}",
      "</style>",
      "</head>",
      "<body>",
      "<div class=\"shell\">",
      "<h1>IT Step Materials Index</h1>",
      "<p class=\"meta\">Vygenerováno: " + Shared.escapeHtml(new Date(payload.generatedAt).toLocaleString("cs-CZ")) + " · Položek: " + Shared.escapeHtml(String(payload.items.length)) + " · Naskenováno: " + Shared.escapeHtml(String(payload.scannedCount)) + "</p>",
      "<table>",
      "<thead><tr><th>Řádek</th><th>Název bloku</th><th>Sloupec</th><th>Štítek</th><th>Typ</th><th>Soubor</th></tr></thead>",
      "<tbody>" + rows + "</tbody>",
      "</table>",
      errors ? "<section class=\"errors\"><h2>Chyby při sběru</h2><ul>" + errors + "</ul></section>" : "",
      "</div>",
      "</body>",
      "</html>"
    ].join("");
  }

  function ensureUniqueZipPath(usedPaths, rawPath) {
    var extension = Shared.extensionFromFileName(rawPath);
    var basePath = extension ? rawPath.slice(0, -extension.length) : rawPath;
    var candidate = rawPath;
    var suffix = 1;
    while (usedPaths.has(candidate)) {
      candidate = basePath + "_" + suffix + extension;
      suffix += 1;
    }
    usedPaths.add(candidate);
    return candidate;
  }

  async function triggerDownload(blob, fileName) {
    var blobUrl = URL.createObjectURL(blob);
    try {
      return await chrome.downloads.download({
        url: blobUrl,
        filename: fileName,
        saveAs: false
      });
    } finally {
      setTimeout(function revoke() {
        URL.revokeObjectURL(blobUrl);
      }, 60000);
    }
  }
})(globalThis);
