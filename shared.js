(function bootstrapShared(global) {
  if (global.ItStepShared) {
    return;
  }

  var ACTIONS = {
    GET_JOB_STATE: "getJobState",
    SCAN_CURRENT_PAGE: "scanCurrentPage",
    DOWNLOAD_HTML_INDEX: "downloadHtmlIndex",
    DOWNLOAD_ZIP: "downloadZip",
    OPEN_FILE: "openFile",
    COLLECT_MATERIALS: "collectMaterials",
    SCAN_PROGRESS: "scanProgress",
    JOB_STATE_UPDATED: "jobStateUpdated",
    OFFSCREEN_DOWNLOAD_HTML: "offscreenDownloadHtml",
    OFFSCREEN_DOWNLOAD_ZIP: "offscreenDownloadZip"
  };

  var JOB_STATUS = {
    IDLE: "idle",
    RUNNING: "running",
    COMPLETED: "completed",
    ERROR: "error"
  };

  var STORAGE_KEYS = {
    JOB_STATE: "jobState"
  };
  var DEBUG = true;

  var MATERIAL_TYPES = {
    BASE: "Zakladni-materialy",
    SUPPLEMENTARY: "Doplnkove-materialy"
  };

  var MATERIAL_COLORS = {
    BLUE: "#02a8f4",
    PURPLE: "#9b87fa"
  };

  function normalizeText(value) {
    return String(value || "")
      .replace(/\r/g, "\n")
      .replace(/\n+/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, " / ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripDiacritics(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function slugifySegment(value, fallback) {
    var cleaned = stripDiacritics(value)
      .replace(/&/g, " and ")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return cleaned || fallback || "item";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function delay(ms) {
    return new Promise(function wait(resolve) {
      setTimeout(resolve, ms);
    });
  }

  function isSupportedMaterialsUrl(url) {
    try {
      var parsed = new URL(url);
      return parsed.origin === "https://lb.itstep.org" && parsed.pathname === "/materials";
    } catch (error) {
      return false;
    }
  }

  function isMaterialFileUrl(url) {
    var value = String(url || "");
    return /^https:\/\/fsx1\.itstep\.org\/api\/v1\/files\//i.test(value)
      || /^https:\/\/materials\.itstep\.org\/content\//i.test(value);
  }

  function parseColorToHex(input) {
    var value = String(input || "").trim().toLowerCase();
    if (!value) {
      return "";
    }

    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return "#" + value.slice(1).split("").map(function expand(char) {
        return char + char;
      }).join("");
    }

    if (/^#[0-9a-f]{6}$/i.test(value)) {
      return value;
    }

    var rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
    if (!rgbMatch) {
      return "";
    }

    var parts = rgbMatch[1].split(",").map(function mapPart(part) {
      return Number.parseInt(part.trim(), 10);
    });
    if (parts.length < 3 || parts.some(function isNaNPart(part) {
      return Number.isNaN(part);
    })) {
      return "";
    }

    return "#" + parts.slice(0, 3).map(function toHex(part) {
      return Math.max(0, Math.min(255, part)).toString(16).padStart(2, "0");
    }).join("");
  }

  function materialTypeFromColor(color) {
    var hex = parseColorToHex(color);
    if (hex === MATERIAL_COLORS.BLUE) {
      return MATERIAL_TYPES.BASE;
    }
    if (hex === MATERIAL_COLORS.PURPLE) {
      return MATERIAL_TYPES.SUPPLEMENTARY;
    }
    return "";
  }

  function buildItemId(meta, index) {
    return [
      slugifySegment(meta.rowNumber, "row"),
      slugifySegment(meta.columnTitle, "column"),
      slugifySegment(meta.chipLabel, "material"),
      String(index)
    ].join("__");
  }

  function buildBaseFileName(item) {
    return [
      slugifySegment(item.rowNumber, "row"),
      slugifySegment(item.columnTitle, "column"),
      slugifySegment(item.chipLabel, "material")
    ].join("_");
  }

  function serializeError(error) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error === "string") {
      return error;
    }
    return error.message || String(error);
  }

  function parseFilenameFromContentDisposition(headerValue) {
    var value = String(headerValue || "");
    if (!value) {
      return "";
    }

    var utfMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (utfMatch) {
      try {
        return decodeURIComponent(utfMatch[1]).trim().replace(/^"|"$/g, "");
      } catch (error) {
        return utfMatch[1].trim().replace(/^"|"$/g, "");
      }
    }

    var plainMatch = value.match(/filename="?([^";]+)"?/i);
    return plainMatch ? plainMatch[1].trim() : "";
  }

  function extensionFromFileName(fileName) {
    var match = String(fileName || "").match(/(\.[a-z0-9]{1,10})$/i);
    return match ? match[1].toLowerCase() : "";
  }

  function extensionFromContentType(contentType) {
    var normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
    var map = {
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/json": ".json",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "application/vnd.ms-powerpoint": ".ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
      "text/plain": ".txt",
      "text/html": ".html",
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "video/mp4": ".mp4"
    };
    return map[normalized] || "";
  }

  function formatTimestampForFile(dateLike) {
    var date = dateLike ? new Date(dateLike) : new Date();
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    var hours = String(date.getHours()).padStart(2, "0");
    var minutes = String(date.getMinutes()).padStart(2, "0");
    return [year, month, day].join("-") + "_" + [hours, minutes].join("-");
  }

  function formatDateForFile(dateLike) {
    var date = dateLike ? new Date(dateLike) : new Date();
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return [year, month, day].join("-");
  }

  function debugLog(scope) {
    if (!DEBUG) {
      return;
    }

    var args = Array.prototype.slice.call(arguments, 1);
    console.log.apply(console, ["[IT Step][" + scope + "]"].concat(args));
  }

  global.ItStepShared = {
    ACTIONS: ACTIONS,
    JOB_STATUS: JOB_STATUS,
    STORAGE_KEYS: STORAGE_KEYS,
    DEBUG: DEBUG,
    MATERIAL_TYPES: MATERIAL_TYPES,
    MATERIAL_COLORS: MATERIAL_COLORS,
    normalizeText: normalizeText,
    stripDiacritics: stripDiacritics,
    slugifySegment: slugifySegment,
    escapeHtml: escapeHtml,
    delay: delay,
    isSupportedMaterialsUrl: isSupportedMaterialsUrl,
    isMaterialFileUrl: isMaterialFileUrl,
    parseColorToHex: parseColorToHex,
    materialTypeFromColor: materialTypeFromColor,
    buildItemId: buildItemId,
    buildBaseFileName: buildBaseFileName,
    serializeError: serializeError,
    parseFilenameFromContentDisposition: parseFilenameFromContentDisposition,
    extensionFromFileName: extensionFromFileName,
    extensionFromContentType: extensionFromContentType,
    formatTimestampForFile: formatTimestampForFile,
    formatDateForFile: formatDateForFile,
    debugLog: debugLog
  };
})(globalThis);
