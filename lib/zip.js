(function bootstrapZipBuilder(global) {
  if (global.ItStepZipBuilder) {
    return;
  }

  var encoder = new TextEncoder();
  var crcTable = createCrcTable();

  function createCrcTable() {
    var table = new Uint32Array(256);
    for (var index = 0; index < 256; index += 1) {
      var value = index;
      for (var bit = 0; bit < 8; bit += 1) {
        if ((value & 1) === 1) {
          value = 0xedb88320 ^ (value >>> 1);
        } else {
          value = value >>> 1;
        }
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    var value = 0xffffffff;
    for (var index = 0; index < bytes.length; index += 1) {
      value = crcTable[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (typeof value === "string") {
      return encoder.encode(value);
    }
    return new Uint8Array(value);
  }

  function dateToDos(dateLike) {
    var date = dateLike instanceof Date ? dateLike : new Date(dateLike || Date.now());
    var year = Math.max(1980, date.getFullYear());
    var dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    var dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return {
      time: dosTime,
      date: dosDate
    };
  }

  function writeUint16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function ZipBuilder() {
    this.entries = [];
  }

  ZipBuilder.prototype.addFile = function addFile(path, content, modifiedAt) {
    var fileNameBytes = encoder.encode(String(path).replace(/\\/g, "/"));
    var fileBytes = toUint8Array(content);
    var timestamp = dateToDos(modifiedAt);

    this.entries.push({
      path: path,
      nameBytes: fileNameBytes,
      fileBytes: fileBytes,
      crc32: crc32(fileBytes),
      modifiedTime: timestamp.time,
      modifiedDate: timestamp.date,
      localOffset: 0
    });
  };

  ZipBuilder.prototype.addText = function addText(path, content) {
    this.addFile(path, encoder.encode(String(content || "")), new Date());
  };

  ZipBuilder.prototype.build = function build() {
    var localSize = 0;
    var centralSize = 0;

    this.entries.forEach(function measure(entry) {
      localSize += 30 + entry.nameBytes.length + entry.fileBytes.length;
      centralSize += 46 + entry.nameBytes.length;
    });

    var totalSize = localSize + centralSize + 22;
    var bytes = new Uint8Array(totalSize);
    var view = new DataView(bytes.buffer);
    var offset = 0;

    this.entries.forEach(function writeLocalEntry(entry) {
      entry.localOffset = offset;
      writeUint32(view, offset, 0x04034b50);
      writeUint16(view, offset + 4, 20);
      writeUint16(view, offset + 6, 0x0800);
      writeUint16(view, offset + 8, 0);
      writeUint16(view, offset + 10, entry.modifiedTime);
      writeUint16(view, offset + 12, entry.modifiedDate);
      writeUint32(view, offset + 14, entry.crc32);
      writeUint32(view, offset + 18, entry.fileBytes.length);
      writeUint32(view, offset + 22, entry.fileBytes.length);
      writeUint16(view, offset + 26, entry.nameBytes.length);
      writeUint16(view, offset + 28, 0);
      bytes.set(entry.nameBytes, offset + 30);
      bytes.set(entry.fileBytes, offset + 30 + entry.nameBytes.length);
      offset += 30 + entry.nameBytes.length + entry.fileBytes.length;
    });

    var centralDirectoryOffset = offset;

    this.entries.forEach(function writeCentralEntry(entry) {
      writeUint32(view, offset, 0x02014b50);
      writeUint16(view, offset + 4, 20);
      writeUint16(view, offset + 6, 20);
      writeUint16(view, offset + 8, 0x0800);
      writeUint16(view, offset + 10, 0);
      writeUint16(view, offset + 12, entry.modifiedTime);
      writeUint16(view, offset + 14, entry.modifiedDate);
      writeUint32(view, offset + 16, entry.crc32);
      writeUint32(view, offset + 20, entry.fileBytes.length);
      writeUint32(view, offset + 24, entry.fileBytes.length);
      writeUint16(view, offset + 28, entry.nameBytes.length);
      writeUint16(view, offset + 30, 0);
      writeUint16(view, offset + 32, 0);
      writeUint16(view, offset + 34, 0);
      writeUint16(view, offset + 36, 0);
      writeUint32(view, offset + 38, 0);
      writeUint32(view, offset + 42, entry.localOffset);
      bytes.set(entry.nameBytes, offset + 46);
      offset += 46 + entry.nameBytes.length;
    });

    var centralDirectorySize = offset - centralDirectoryOffset;
    writeUint32(view, offset, 0x06054b50);
    writeUint16(view, offset + 4, 0);
    writeUint16(view, offset + 6, 0);
    writeUint16(view, offset + 8, this.entries.length);
    writeUint16(view, offset + 10, this.entries.length);
    writeUint32(view, offset + 12, centralDirectorySize);
    writeUint32(view, offset + 16, centralDirectoryOffset);
    writeUint16(view, offset + 20, 0);

    return new Blob([bytes], {
      type: "application/zip"
    });
  };

  global.ItStepZipBuilder = ZipBuilder;
})(globalThis);
