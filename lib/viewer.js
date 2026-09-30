// In-page PDF viewer for one evidence file: renders a page, boxes the
// published figures on it, scrolls the current figure into view, and reports
// whether the file's bytes match the hash the release records.

import { openPdf, outlineBox, verifyWholeFile } from "./evidence.js";
import { fmtBytes } from "./model.js";
import { el } from "./dom.js";

const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const MAX_CANVAS_PIXELS = 24_000_000;

export class PdfViewer {
  constructor(root, { onBoxClick, onPageChange } = {}) {
    this.root = root;
    this.onBoxClick = onBoxClick;
    this.onPageChange = onPageChange;
    this.zoom = 1;
    this.seq = 0;
    this.renderTask = null;
    this.opts = null;
    this.entry = null;

    this.zoomOut = el("button", { class: "btn pv-btn", type: "button", title: "Zoom out", "aria-label": "Zoom out", text: "−", onclick: () => this.stepZoom(-1) });
    this.zoomFit = el("button", { class: "btn pv-btn", type: "button", title: "Fit page width", text: "Fit", onclick: () => this.setZoom(1) });
    this.zoomIn = el("button", { class: "btn pv-btn", type: "button", title: "Zoom in", "aria-label": "Zoom in", text: "+", onclick: () => this.stepZoom(1) });
    this.findBtn = el("button", { class: "btn pv-btn", type: "button", title: "Scroll to the outlined figure", text: "Go to figure", onclick: () => this.goToFigure(true) });
    this.prevBtn = el("button", { class: "btn pv-btn", type: "button", title: "Previous page", "aria-label": "Previous page", text: "‹", onclick: () => this.turn(-1) });
    this.nextBtn = el("button", { class: "btn pv-btn", type: "button", title: "Next page", "aria-label": "Next page", text: "›", onclick: () => this.turn(1) });
    this.pageLabel = el("span", { class: "pv-page", "aria-live": "polite" });
    this.pager = el("span", { class: "pv-pager" }, this.prevBtn, this.pageLabel, this.nextBtn);
    this.toolbar = el("div", { class: "pv-toolbar" }, this.zoomOut, this.zoomFit, this.zoomIn, el("span", { class: "sep" }), this.findBtn, this.pager);
    this.note = el("div", { class: "pv-note", role: "note", hidden: true });

    this.canvas = el("canvas", { class: "pv-canvas" });
    this.boxLayer = el("div", { class: "pv-boxes" });
    this.message = el("div", { class: "pv-message", role: "status" });
    this.stage = el("div", { class: "pv-stage" }, this.canvas, this.boxLayer);
    this.scroll = el("div", { class: "pv-scroll", tabindex: "0", "aria-label": "Evidence page" }, this.stage, this.message);

    this.verifyText = el("span", { class: "pv-verify-text" });
    this.verifyBtn = el("button", { class: "btn pv-btn", type: "button", hidden: true, text: "Check SHA-256", onclick: () => this.verifyWhole() });
    this.verify = el("div", { class: "pv-verify" }, this.verifyText, this.verifyBtn);

    root.classList.add("pv");
    root.replaceChildren(this.toolbar, this.note, this.scroll, this.verify);

    this.resize = new ResizeObserver(() => {
      const w = this.scroll.clientWidth;
      if (this.opts && w && Math.abs(w - (this.lastWidth || 0)) > 8) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.render({ keepScroll: true }), 120);
      }
    });
    this.resize.observe(this.scroll);
  }

  // opts: { url, sha256, bytes, page, paging, boxesForPage(page) -> [{rect,id,label,current}], focusOnCurrent }
  async show(opts) {
    const sameDoc = this.opts && this.opts.url === opts.url;
    this.opts = { ...opts };
    if (!sameDoc) this.zoom = 1;
    this.pager.hidden = !opts.paging;
    await this.render({ scrollToFigure: true });
  }

  setZoom(z) {
    this.zoom = z;
    this.render({ scrollToFigure: true });
  }

  stepZoom(dir) {
    const i = ZOOMS.findIndex((z) => z >= this.zoom - 1e-6);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 2 : i) + dir))];
    this.setZoom(next);
  }

  turn(dir) {
    if (!this.opts || !this.pageCount) return;
    const page = Math.max(1, Math.min(this.pageCount, this.opts.page + dir));
    if (page === this.opts.page) return;
    this.opts.page = page;
    this.onPageChange?.(page);
    this.render({ scrollTop: true });
  }

  goToPage(page) {
    if (!this.opts) return;
    this.opts.page = page;
    this.render({ scrollToFigure: true });
  }

  setStatus(text, kind = "") {
    this.message.textContent = text;
    this.message.className = `pv-message ${kind}`;
    this.message.hidden = !text;
  }

  showVerification(v) {
    this.verifyBtn.hidden = true;
    this.verify.className = "pv-verify";
    if (!v) {
      this.verifyText.textContent = "";
      return;
    }
    const short = v.hash ? v.hash.slice(0, 12) : "";
    if (v.status === "match") {
      this.verify.classList.add("ok");
      this.verifyText.textContent = `✓ SHA-256 ${short}… matches the release`;
      this.verifyText.title = v.hash;
    } else if (v.status === "mismatch") {
      this.verify.classList.add("bad");
      this.verifyText.textContent = `✗ SHA-256 ${short}… does not match the release (${v.expected.slice(0, 12)}…)`;
      this.verifyText.title = `got ${v.hash}\nexpected ${v.expected}`;
    } else if (v.status === "partial") {
      this.verifyText.textContent = `Read by byte range (${fmtBytes(v.bytes)}); hash not yet checked.`;
      this.verifyText.title = "";
      this.verifyBtn.hidden = !v.expected;
      this.verifyBtn.textContent = `Download ${fmtBytes(v.bytes)} and check SHA-256`;
    } else {
      this.verifyText.textContent = "The release records no hash for this file.";
      this.verifyText.title = "";
    }
  }

  async verifyWhole() {
    const o = this.opts;
    if (!o) return;
    this.verifyBtn.disabled = true;
    try {
      const v = await verifyWholeFile(o.url, o.sha256, o.bytes, (loaded, total) => {
        this.verifyText.textContent = `Checking… ${fmtBytes(loaded)}${total ? ` of ${fmtBytes(total)}` : ""}`;
      });
      if (this.opts === o) this.showVerification(v);
    } catch (err) {
      this.verifyText.textContent = `Could not download the file to check it: ${err.message}`;
    } finally {
      this.verifyBtn.disabled = false;
    }
  }

  async render({ scrollToFigure = false, keepScroll = false, scrollTop = false } = {}) {
    const o = this.opts;
    if (!o) return;
    const seq = ++this.seq;
    const prevScroll = { top: this.scroll.scrollTop, left: this.scroll.scrollLeft, h: this.stage.offsetHeight || 1 };
    this.setStatus(this.entry && this.entry.url === o.url ? "" : "Opening the PDF…");
    let entry;
    try {
      entry = await openPdf(o.url, {
        sha256: o.sha256,
        bytes: o.bytes,
        onProgress: (loaded, total) => {
          if (seq === this.seq) this.setStatus(`Downloading ${fmtBytes(loaded)}${total ? ` of ${fmtBytes(total)}` : ""}…`);
        },
      });
      if (seq !== this.seq) return;
      this.entry = { url: o.url };
      this.showVerification(entry.verification);
      this.pageCount = entry.doc.numPages;
      o.page = Math.max(1, Math.min(this.pageCount, o.page || 1));
      this.pageLabel.textContent = `Page ${o.page} of ${this.pageCount}`;
      this.prevBtn.disabled = o.page <= 1;
      this.nextBtn.disabled = o.page >= this.pageCount;

      const pagePromise = entry.doc.getPage(o.page);
      const page = entry.failed ? await Promise.race([pagePromise, entry.failed]) : await pagePromise;
      if (seq !== this.seq) return;

      const width = Math.max(200, this.scroll.clientWidth - 2);
      this.lastWidth = this.scroll.clientWidth;
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let scale = (width / base.width) * this.zoom * dpr;
      const pixels = base.width * base.height * scale * scale;
      if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale });

      if (this.renderTask) this.renderTask.cancel();
      const canvas = document.createElement("canvas");
      canvas.className = "pv-canvas";
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      this.renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport });
      const rendered = entry.failed ? Promise.race([this.renderTask.promise, entry.failed]) : this.renderTask.promise;
      await rendered;
      if (seq !== this.seq) return;
      this.renderTask = null;
      this.canvas.replaceWith(canvas);
      this.canvas = canvas;
      this.stage.style.width = canvas.style.width;
      this.stage.style.height = canvas.style.height;
      this.setStatus("");
      await this.drawBoxes(page, viewport, dpr, seq);
      if (seq !== this.seq) return;

      if (scrollToFigure && this.currentBox) this.goToFigure(false);
      else if (scrollToFigure) this.scroll.scrollTo(0, 0);
      else if (scrollTop) this.scroll.scrollTo(0, 0);
      else if (keepScroll) {
        const ratio = this.stage.offsetHeight / prevScroll.h;
        this.scroll.scrollTo(prevScroll.left * ratio, prevScroll.top * ratio);
      }
    } catch (err) {
      if (seq !== this.seq || err?.name === "RenderingCancelledException") return;
      this.setStatus(`Could not display this PDF: ${err.message || err}`, "err");
    }
  }

  // Boxes come from recorded rectangles. A box with a verify() is drawn only
  // once that check confirms the rectangle sits on the outline in the figure's
  // own evidence file; one that fails is never drawn.
  async drawBoxes(page, viewport, dpr, seq) {
    const o = this.opts;
    const boxes = (o.boxesForPage ? o.boxesForPage(o.page) : []).filter((b) => b.rect);
    this.currentBox = null;
    this.boxLayer.replaceChildren();
    this.findBtn.hidden = true;
    this.note.hidden = true;
    const place = (b) => {
      const px = outlineBox(viewport, page.view, b.rect);
      const pad = 3;
      const css = {
        left: px.left / dpr - pad,
        top: px.top / dpr - pad,
        width: px.width / dpr + pad * 2,
        height: px.height / dpr + pad * 2,
      };
      const cls = ["pv-box", b.current ? "current" : "other", b.current && o.outlineInFile ? "in-file" : ""].filter(Boolean).join(" ");
      const node = el(b.current ? "div" : "button", {
        class: cls,
        type: b.current ? null : "button",
        title: b.label || "",
        "aria-label": b.current ? null : `Open figure: ${b.label || ""}`,
        "data-figure": b.id,
        "data-canvas-box": JSON.stringify([px.left, px.top, px.width, px.height].map((v) => Math.round(v))),
        onclick: b.current ? null : () => this.onBoxClick?.(b.id),
      });
      Object.assign(node.style, {
        left: `${css.left}px`,
        top: `${css.top}px`,
        width: `${css.width}px`,
        height: `${css.height}px`,
      });
      this.boxLayer.append(node);
      if (b.current) {
        this.currentBox = { node, css };
        this.findBtn.hidden = false;
      }
    };
    const pending = [];
    for (const b of boxes) {
      if (!b.verify) {
        place(b);
        continue;
      }
      const check = b.verify().then(
        (res) => {
          if (seq !== this.seq) return;
          if (res?.agrees) place(b);
          else if (b.current) this.showNote(o.mismatchNote || "The recorded rectangle for this figure does not line up with its evidence outline, so no box is drawn.");
        },
        () => {
          if (seq === this.seq && b.current) this.showNote("The outline check for this figure could not run, so no box is drawn.");
        },
      );
      if (b.current) pending.push(check);
    }
    await Promise.all(pending);
  }

  showNote(text) {
    this.note.textContent = text;
    this.note.hidden = false;
  }

  goToFigure(flash) {
    const box = this.currentBox;
    if (!box) return;
    const s = this.scroll;
    s.scrollTo({
      left: Math.max(0, box.css.left + box.css.width / 2 - s.clientWidth / 2),
      top: Math.max(0, box.css.top + box.css.height / 2 - s.clientHeight / 2),
    });
    const n = box.node;
    n.classList.remove("flash");
    if (flash !== false || this.opts?.outlineInFile) {
      void n.offsetWidth;
      n.classList.add("flash");
    }
  }

  clear() {
    this.seq += 1;
    this.opts = null;
    this.entry = null;
    this.boxLayer.replaceChildren();
    this.note.hidden = true;
    this.setStatus("");
    this.showVerification(null);
  }
}
