/* ==========================================================================
   Valkyrie web flasher - wardrive log downloader (Web Serial)

   Pulls the Wigle 1.6 CSVs the watch writes to /valkyrie/wardrive/ straight
   from the browser, with no install. This is a from-scratch JS port of the
   protocol proven by firmware/bin/valkyrie-wardrive-pull.py:

     1. Meshtastic stream framing over Web Serial:
          START1(0x94) START2(0xc3) lenHi lenLo <protobuf>
     2. Config handshake to collect the file manifest. We use the
        SPECIAL_NONCE_ONLY_CONFIG (69420) want_config_id so the device skips
        the node DB and jumps straight to config -> file manifest -> complete.
     3. XModem file download (mirrors firmware src/xmodem.cpp transmit path):
          host -> STX seq=0 + path
          device -> SOH seq=N + <=128 B block + crc16   (host CRC-checks, ACKs)
          device -> EOT  (done)

   Only the handful of protobuf fields we need are hand-encoded/decoded, so
   there is no protobuf runtime dependency and no build step.

   All flashing is still handled by ESP Web Tools; this file is independent and
   opens/closes its own serial port so the two never fight over it.
   ========================================================================== */

(function () {
  "use strict";

  const START1 = 0x94;
  const START2 = 0xc3;
  const MAX_FRAME = 512;
  const BAUD = 115200;
  const WARDRIVE_PREFIX = "/valkyrie/wardrive/";
  const SPECIAL_NONCE_ONLY_CONFIG = 69420;

  // XModem control codes (from firmware xmodem.pb.h).
  const XM = { NUL: 0, SOH: 1, STX: 2, EOT: 4, ACK: 6, NAK: 21, CAN: 24 };

  // Protobuf field tags (from firmware generated headers).
  const TORADIO_WANT_CONFIG_ID = 3; // varint
  const TORADIO_XMODEMPACKET = 5; // message
  const FROMRADIO_CONFIG_COMPLETE_ID = 7; // varint
  const FROMRADIO_XMODEMPACKET = 12; // message
  const FROMRADIO_FILEINFO = 15; // message
  const XMODEM_CONTROL = 1;
  const XMODEM_SEQ = 2;
  const XMODEM_CRC16 = 3;
  const XMODEM_BUFFER = 4;
  const FILEINFO_FILE_NAME = 1;
  const FILEINFO_SIZE_BYTES = 2;

  const FIRST_BLOCK_TIMEOUT = 15000;
  const BLOCK_TIMEOUT = 8000;
  const MANIFEST_TIMEOUT = 25000;
  const DOWNLOAD_ATTEMPTS = 3;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const utf8 = new TextEncoder();
  const utf8dec = new TextDecoder();

  /* ---------------------------------------------------------------------- */
  /* CRC16-CCITT (poly 0x1021, init 0x0000) — matches firmware crc16_ccitt. */
  /* ---------------------------------------------------------------------- */
  function crc16(bytes) {
    let crc = 0;
    for (let j = 0; j < bytes.length; j++) {
      crc ^= bytes[j] << 8;
      for (let i = 0; i < 8; i++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc & 0xffff;
  }

  /* ---------------------------------------------------------------------- */
  /* Minimal protobuf encode/decode                                         */
  /* ---------------------------------------------------------------------- */
  function pushVarint(arr, value) {
    // value fits in <= 32 bits for every field we send.
    value = value >>> 0;
    while (value > 0x7f) {
      arr.push((value & 0x7f) | 0x80);
      value = value >>> 7;
    }
    arr.push(value);
  }

  function pushField(arr, field, wire) {
    pushVarint(arr, field * 8 + wire);
  }

  function encodeXModem({ control = 0, seq = 0, crc = 0, buffer = null }) {
    const out = [];
    if (control) {
      pushField(out, XMODEM_CONTROL, 0);
      pushVarint(out, control);
    }
    if (seq) {
      pushField(out, XMODEM_SEQ, 0);
      pushVarint(out, seq);
    }
    if (crc) {
      pushField(out, XMODEM_CRC16, 0);
      pushVarint(out, crc);
    }
    if (buffer && buffer.length) {
      pushField(out, XMODEM_BUFFER, 2);
      pushVarint(out, buffer.length);
      for (let i = 0; i < buffer.length; i++) out.push(buffer[i]);
    }
    return out;
  }

  function encodeToRadioWantConfig(id) {
    const out = [];
    pushField(out, TORADIO_WANT_CONFIG_ID, 0);
    pushVarint(out, id);
    return Uint8Array.from(out);
  }

  function encodeToRadioXModem(xmodemBytes) {
    const out = [];
    pushField(out, TORADIO_XMODEMPACKET, 2);
    pushVarint(out, xmodemBytes.length);
    for (let i = 0; i < xmodemBytes.length; i++) out.push(xmodemBytes[i]);
    return Uint8Array.from(out);
  }

  // Read a varint; returns [value, newPos]. Uses multiplication so values
  // beyond 31 bits stay exact (up to 53 bits — plenty for uint32 fields).
  function readVarint(buf, pos) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = buf[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (b & 0x80);
    return [result, pos];
  }

  // Parse a protobuf message into { field: value }. varint -> Number,
  // length-delimited -> Uint8Array. Later fields win; unknown wire types
  // are skipped. Returns null if the bytes are malformed.
  function parseMessage(buf) {
    const fields = {};
    let pos = 0;
    try {
      while (pos < buf.length) {
        let tag;
        [tag, pos] = readVarint(buf, pos);
        const field = Math.floor(tag / 8);
        const wire = tag & 7;
        if (wire === 0) {
          let v;
          [v, pos] = readVarint(buf, pos);
          fields[field] = v;
        } else if (wire === 2) {
          let len;
          [len, pos] = readVarint(buf, pos);
          fields[field] = buf.subarray(pos, pos + len);
          pos += len;
        } else if (wire === 5) {
          pos += 4;
        } else if (wire === 1) {
          pos += 8;
        } else {
          return null; // groups / unknown — bail
        }
      }
    } catch (_e) {
      return null;
    }
    return fields;
  }

  function decodeFromRadio(payload) {
    const f = parseMessage(payload);
    if (!f) return null;
    const msg = {};
    if (FROMRADIO_CONFIG_COMPLETE_ID in f) {
      msg.configCompleteId = f[FROMRADIO_CONFIG_COMPLETE_ID];
    }
    if (f[FROMRADIO_FILEINFO] instanceof Uint8Array) {
      const fi = parseMessage(f[FROMRADIO_FILEINFO]);
      if (fi) {
        msg.fileInfo = {
          fileName:
            fi[FILEINFO_FILE_NAME] instanceof Uint8Array
              ? utf8dec.decode(fi[FILEINFO_FILE_NAME])
              : "",
          sizeBytes: fi[FILEINFO_SIZE_BYTES] || 0,
        };
      }
    }
    if (f[FROMRADIO_XMODEMPACKET] instanceof Uint8Array) {
      const xm = parseMessage(f[FROMRADIO_XMODEMPACKET]);
      if (xm) {
        msg.xmodem = {
          control: xm[XMODEM_CONTROL] || 0,
          seq: xm[XMODEM_SEQ] || 0,
          crc16: xm[XMODEM_CRC16] || 0,
          buffer:
            xm[XMODEM_BUFFER] instanceof Uint8Array
              ? xm[XMODEM_BUFFER]
              : new Uint8Array(0),
        };
      }
    }
    return msg;
  }

  /* ---------------------------------------------------------------------- */
  /* Serial transport — frames in/out, dispatches decoded FromRadio msgs.   */
  /* ---------------------------------------------------------------------- */
  class MeshSerial {
    constructor(port) {
      this.port = port;
      this.reader = null;
      this.writer = null;
      this.running = false;
      this._rx = new Uint8Array(0);
      this._queue = [];
      this._waiters = [];
    }

    async open() {
      await this.port.open({ baudRate: BAUD });
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.running = true;
      this._pump();
      // Wake a sleeping device and force a state-machine resync (32x START2),
      // exactly like the meshtastic library's connect().
      await this._writeRaw(new Uint8Array(32).fill(START2));
      await sleep(120);
    }

    async _writeRaw(bytes) {
      if (this.writer) await this.writer.write(bytes);
    }

    async send(payload) {
      const len = payload.length;
      const frame = new Uint8Array(4 + len);
      frame[0] = START1;
      frame[1] = START2;
      frame[2] = (len >> 8) & 0xff;
      frame[3] = len & 0xff;
      frame.set(payload, 4);
      await this._writeRaw(frame);
    }

    async _pump() {
      try {
        while (this.running) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) this._ingest(value);
        }
      } catch (_e) {
        /* reader cancelled / port closed */
      }
    }

    _ingest(chunk) {
      const merged = new Uint8Array(this._rx.length + chunk.length);
      merged.set(this._rx);
      merged.set(chunk, this._rx.length);
      this._rx = merged;
      this._scan();
    }

    _scan() {
      const buf = this._rx;
      let i = 0;
      while (i < buf.length) {
        if (buf[i] !== START1) {
          i++; // log/debug text between frames — drop it
          continue;
        }
        if (buf.length - i < 4) break; // need full header
        if (buf[i + 1] !== START2) {
          i++;
          continue;
        }
        const len = (buf[i + 2] << 8) | buf[i + 3];
        if (len > MAX_FRAME) {
          i++; // bogus length, resync
          continue;
        }
        if (buf.length - i < 4 + len) break; // wait for the rest
        const payload = buf.subarray(i + 4, i + 4 + len);
        const msg = decodeFromRadio(payload);
        if (msg) this._dispatch(msg);
        i += 4 + len;
      }
      this._rx = buf.subarray(i);
    }

    _dispatch(msg) {
      const w = this._waiters.shift();
      if (w) w.resolve(msg);
      else this._queue.push(msg);
    }

    drain() {
      this._queue = [];
    }

    receive(timeoutMs) {
      if (this._queue.length) return Promise.resolve(this._queue.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const idx = this._waiters.indexOf(waiter);
          if (idx >= 0) this._waiters.splice(idx, 1);
          reject(new Error("timeout"));
        }, timeoutMs);
        const wrapped = {
          resolve: (m) => {
            clearTimeout(waiter.timer);
            resolve(m);
          },
          reject: waiter.reject,
        };
        this._waiters.push(wrapped);
      });
    }

    async close() {
      this.running = false;
      try {
        if (this.reader) await this.reader.cancel();
      } catch (_e) {}
      try {
        if (this.reader) this.reader.releaseLock();
      } catch (_e) {}
      try {
        if (this.writer) this.writer.releaseLock();
      } catch (_e) {}
      try {
        await this.port.close();
      } catch (_e) {}
      // Fail any pending waiters so callers don't hang.
      this._waiters.forEach((w) => w.reject(new Error("port closed")));
      this._waiters = [];
    }

    /* --------- high-level operations --------- */

    async fetchManifest() {
      this.drain();
      await this.send(encodeToRadioWantConfig(SPECIAL_NONCE_ONLY_CONFIG));
      const files = [];
      const deadline = Date.now() + MANIFEST_TIMEOUT;
      while (Date.now() < deadline) {
        let msg;
        try {
          msg = await this.receive(FIRST_BLOCK_TIMEOUT);
        } catch (_e) {
          break;
        }
        if (msg.fileInfo && msg.fileInfo.fileName) files.push(msg.fileInfo);
        if (msg.configCompleteId === SPECIAL_NONCE_ONLY_CONFIG) break;
      }
      return files;
    }

    async downloadFile(path, attempts = DOWNLOAD_ATTEMPTS) {
      let lastErr = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        await sleep(200);
        this.drain();
        try {
          return await this._downloadOnce(path);
        } catch (err) {
          lastErr = err;
          if (attempt < attempts) await sleep(500 * attempt);
        }
      }
      throw lastErr || new Error("download failed");
    }

    async _downloadOnce(path) {
      const data = [];
      // Kick off the transfer: STX + filename in seq 0. We deliberately never
      // send CAN to recover — the firmware's CAN handler deletes the file.
      await this.send(encodeToRadioXModem(encodeXModem({ control: XM.STX, buffer: utf8.encode(path) })));

      let wait = FIRST_BLOCK_TIMEOUT;
      while (true) {
        let msg;
        try {
          msg = await this.receive(wait);
        } catch (_e) {
          throw new Error(
            `timed out waiting for device data on ${path} — is the watch awake?`
          );
        }
        wait = BLOCK_TIMEOUT;
        if (!msg.xmodem) continue; // ignore unrelated frames
        const x = msg.xmodem;
        if (x.control === XM.SOH || x.control === XM.STX) {
          const chunk = x.buffer;
          if (crc16(chunk) !== x.crc16) {
            await this.send(encodeToRadioXModem(encodeXModem({ control: XM.NAK })));
            continue;
          }
          for (let i = 0; i < chunk.length; i++) data.push(chunk[i]);
          await this.send(encodeToRadioXModem(encodeXModem({ control: XM.ACK })));
        } else if (x.control === XM.EOT) {
          break;
        } else if (x.control === XM.NAK) {
          throw new Error(`device refused ${path} (NAK) — file pruned? Refresh the list.`);
        } else if (x.control === XM.CAN) {
          throw new Error(`device canceled transfer of ${path}`);
        } else {
          throw new Error(`unexpected XModem control ${x.control} on ${path}`);
        }
      }
      return Uint8Array.from(data);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* UI wiring                                                              */
  /* ---------------------------------------------------------------------- */
  function canUseWebSerial() {
    return typeof navigator !== "undefined" && "serial" in navigator && window.isSecureContext;
  }

  function initWardrive() {
    const root = document.querySelector("[data-wardrive]");
    if (!root) return;

    const els = {
      connect: root.querySelector("[data-wd-connect]"),
      disconnect: root.querySelector("[data-wd-disconnect]"),
      refresh: root.querySelector("[data-wd-refresh]"),
      downloadAll: root.querySelector("[data-wd-download-all]"),
      status: root.querySelector("[data-wd-status]"),
      files: root.querySelector("[data-wd-files]"),
      log: root.querySelector("[data-wd-log]"),
      unsupported: root.querySelector("[data-wd-unsupported]"),
      panel: root.querySelector("[data-wd-panel]"),
    };

    if (!canUseWebSerial()) {
      if (els.unsupported) els.unsupported.hidden = false;
      if (els.panel) els.panel.hidden = true;
      return;
    }

    if (els.unsupported) els.unsupported.hidden = true;
    if (els.panel) els.panel.hidden = false;

    let mesh = null;
    let busy = false;

    const log = (line) => {
      if (!els.log) return;
      const ts = new Date().toLocaleTimeString();
      els.log.textContent += `[${ts}] ${line}\n`;
      els.log.scrollTop = els.log.scrollHeight;
    };
    const setStatus = (text) => {
      if (els.status) els.status.textContent = text;
    };
    const setBusy = (state) => {
      busy = state;
      [els.connect, els.disconnect, els.refresh, els.downloadAll].forEach((b) => {
        if (b) b.disabled = state;
      });
    };
    const setConnected = (connected) => {
      if (els.connect) els.connect.hidden = connected;
      if (els.disconnect) els.disconnect.hidden = !connected;
      if (els.refresh) els.refresh.hidden = !connected;
      if (els.downloadAll) els.downloadAll.hidden = !connected;
    };

    const human = (n) => {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
    };

    const saveBlob = (name, bytes) => {
      const blob = new Blob([bytes], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };

    const baseName = (p) => p.split("/").pop() || p;

    let currentFiles = [];

    const renderFiles = () => {
      if (!els.files) return;
      els.files.innerHTML = "";
      if (!currentFiles.length) {
        els.files.innerHTML =
          '<p class="wd-empty">No wardrive logs on the device yet. Go wardrive, then refresh.</p>';
        if (els.downloadAll) els.downloadAll.disabled = true;
        return;
      }
      if (els.downloadAll) els.downloadAll.disabled = false;
      currentFiles.forEach((file) => {
        const row = document.createElement("div");
        row.className = "wd-file";
        const meta = document.createElement("div");
        meta.className = "wd-file__meta";
        meta.innerHTML =
          `<span class="wd-file__name">${baseName(file.fileName)}</span>` +
          `<span class="wd-file__size">${human(file.sizeBytes)}</span>`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-secondary wd-file__btn";
        btn.textContent = "Download";
        btn.addEventListener("click", () => downloadOne(file));
        row.appendChild(meta);
        row.appendChild(btn);
        els.files.appendChild(row);
      });
    };

    const wardriveCountLabel = (n) =>
      n === 0 ? "No wardrive logs." : n === 1 ? "1 wardrive log." : `${n} wardrive logs.`;

    const list = async () => {
      if (!mesh) return;
      setBusy(true);
      setStatus("Listing wardrive logs…");
      log("Listing wardrive logs…");
      try {
        const all = await mesh.fetchManifest();
        currentFiles = all
          .filter((f) => f.fileName.startsWith(WARDRIVE_PREFIX))
          .sort((a, b) => a.fileName.localeCompare(b.fileName));
        log(wardriveCountLabel(currentFiles.length));
        setStatus(
          currentFiles.length
            ? `Connected · ${wardriveCountLabel(currentFiles.length)}`
            : "Connected · no wardrive logs."
        );
        renderFiles();
      } catch (err) {
        log(`Could not list wardrive logs: ${err.message}`);
        setStatus("Could not list wardrive logs.");
      } finally {
        setBusy(false);
      }
    };

    const downloadOne = async (file) => {
      if (!mesh || busy) return;
      setBusy(true);
      setStatus(`Downloading ${baseName(file.fileName)}…`);
      log(`Downloading ${file.fileName} (${human(file.sizeBytes)})…`);
      try {
        const bytes = await mesh.downloadFile(file.fileName);
        saveBlob(baseName(file.fileName), bytes);
        log(`Saved ${baseName(file.fileName)} — ${bytes.length} B.`);
        if (file.sizeBytes && file.sizeBytes !== bytes.length) {
          log(`  WARNING: manifest said ${file.sizeBytes} B, got ${bytes.length} B.`);
        }
        setStatus(`Saved ${baseName(file.fileName)}.`);
      } catch (err) {
        log(`FAILED: ${err.message}`);
        setStatus(`Failed: ${baseName(file.fileName)}.`);
      } finally {
        setBusy(false);
      }
    };

    const downloadAll = async () => {
      if (!mesh || busy || !currentFiles.length) return;
      setBusy(true);
      let ok = 0;
      let failed = 0;
      for (let i = 0; i < currentFiles.length; i++) {
        const file = currentFiles[i];
        setStatus(`Downloading ${i + 1}/${currentFiles.length}: ${baseName(file.fileName)}…`);
        log(`Downloading ${file.fileName} (${human(file.sizeBytes)})…`);
        try {
          const bytes = await mesh.downloadFile(file.fileName);
          saveBlob(baseName(file.fileName), bytes);
          log(`Saved ${baseName(file.fileName)} — ${bytes.length} B.`);
          ok++;
        } catch (err) {
          log(`FAILED ${baseName(file.fileName)}: ${err.message}`);
          failed++;
        }
        await sleep(400); // let the firmware tear down before the next transfer
      }
      setStatus(`Done · ${ok} saved${failed ? `, ${failed} failed` : ""}.`);
      setBusy(false);
    };

    const connect = async () => {
      setBusy(true);
      setStatus("Requesting serial port…");
      try {
        const port = await navigator.serial.requestPort();
        mesh = new MeshSerial(port);
        await mesh.open();
        setConnected(true);
        log("Connected. Waking device…");
        setBusy(false);
        await list();
      } catch (err) {
        if (err && err.name === "NotFoundError") {
          setStatus("No port selected.");
        } else {
          log(`Connect failed: ${err.message}`);
          setStatus("Connection failed.");
        }
        if (mesh) {
          await mesh.close();
          mesh = null;
        }
        setConnected(false);
        setBusy(false);
      }
    };

    const disconnect = async () => {
      if (mesh) {
        await mesh.close();
        mesh = null;
      }
      currentFiles = [];
      renderFiles();
      setConnected(false);
      setStatus("Disconnected.");
      log("Disconnected.");
    };

    if (els.connect) els.connect.addEventListener("click", connect);
    if (els.disconnect) els.disconnect.addEventListener("click", disconnect);
    if (els.refresh) els.refresh.addEventListener("click", list);
    if (els.downloadAll) els.downloadAll.addEventListener("click", downloadAll);

    setConnected(false);
    renderFiles();
    window.addEventListener("beforeunload", () => {
      if (mesh) mesh.close();
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initWardrive);
    } else {
      initWardrive();
    }
  }

  // Test-only export (no-op in the browser). Lets a Node harness cross-check
  // the protobuf/CRC/framing against the authoritative meshtastic library.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      crc16,
      encodeXModem,
      encodeToRadioWantConfig,
      encodeToRadioXModem,
      decodeFromRadio,
      parseMessage,
      XM,
    };
  }
})();
