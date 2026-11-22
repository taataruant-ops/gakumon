window.NoteSpace = (() => {
  const view = document.getElementById("note-view");
  const canvas = document.getElementById("note-canvas");
  const backBtn = document.getElementById("note-back-btn");
  const bookSelect = document.getElementById("note-book-select");
  const titleInput = document.getElementById("note-title-input");
  const newBookBtn = document.getElementById("note-new-book-btn");
  const statusEl = document.getElementById("note-status");
  const ragBtn = document.getElementById("note-rag-btn");
  const askBtn = document.getElementById("note-ask-btn");

  const widthSelect = document.getElementById("note-width-select");
  const undoBtn = document.getElementById("note-undo-btn");
  const redoBtn = document.getElementById("note-redo-btn");
  const bgFileInput = document.getElementById("note-bg-file");
  const bgBtn = document.getElementById("note-bg-btn");
  const clearBtn = document.getElementById("note-clear-btn");
  const prevPageBtn = document.getElementById("note-prev-page");
  const nextPageBtn = document.getElementById("note-next-page");
  const pageLabel = document.getElementById("note-page-label");

  if (!view || !canvas) return { open: () => {}, close: () => {}, setCallbacks: () => {} };
  const ctx = canvas.getContext("2d");

  const STORAGE_KEY = "study_tutor_ainote_v1";
  const LOGICAL_W = 1400;
  const LOGICAL_H = 960;
  const MAX_PAGES = 5;

  let books = [];
  let currentBookId = "";
  let currentPage = 0;
  let tool = "pen"; // "pen" | "box" | "eraser"
  let color = "#18222d";
  let lineWidth = 3.6;

  let drawing = false;
  let activeStroke = null;
  let redoStack = [];
  let bgImageCache = new Map();
  let onAskWithImage = () => {};
  let onRagUpdated = () => {};

  function setCallbacks(cbs) {
    if (cbs.onAskWithImage) onAskWithImage = cbs.onAskWithImage;
    if (cbs.onRagUpdated) onRagUpdated = cbs.onRagUpdated;
  }

  function makeEmptyPages() {
    return Array.from({ length: MAX_PAGES }, () => ({ strokes: [], bgData: "" }));
  }

  function loadBooks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      books = raw ? JSON.parse(raw) : [];
    } catch {
      books = [];
    }
    if (!Array.isArray(books) || books.length === 0) {
      books = [{ id: String(Date.now()), title: "学習ノート 1", pages: makeEmptyPages() }];
    }
    currentBookId = books[0].id;
    currentPage = 0;
  }

  function saveBooks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
    } catch {
      statusEl.textContent = "保存容量の上限に近づいています";
    }
  }

  function getBook() {
    return books.find((b) => b.id === currentBookId) || books[0];
  }

  function getPage() {
    const book = getBook();
    if (!book.pages || book.pages.length < MAX_PAGES) {
      book.pages = makeEmptyPages();
    }
    return book.pages[currentPage];
  }

  function renderBookSelect() {
    bookSelect.innerHTML = "";
    for (const b of books) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title || "無題ノート";
      bookSelect.appendChild(opt);
    }
    const cur = getBook();
    bookSelect.value = cur.id;
    titleInput.value = cur.title || "";
    pageLabel.textContent = `P. ${currentPage + 1} / ${MAX_PAGES}`;
    prevPageBtn.disabled = currentPage === 0;
    nextPageBtn.disabled = currentPage === MAX_PAGES - 1;
  }

  function drawRuledBackground() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    // 学習ノート風の淡い横罫線
    ctx.strokeStyle = "#e6edf7";
    ctx.lineWidth = 1;
    for (let y = 64; y < LOGICAL_H; y += 44) {
      ctx.beginPath();
      ctx.moveTo(28, y);
      ctx.lineTo(LOGICAL_W - 28, y);
      ctx.stroke();
    }
    // 左端の余白線
    ctx.strokeStyle = "#f4d5d5";
    ctx.beginPath();
    ctx.moveTo(84, 24);
    ctx.lineTo(84, LOGICAL_H - 24);
    ctx.stroke();
  }

  function drawStroke(s) {
    if (!s) return;
    ctx.save();
    ctx.strokeStyle = s.color || "#18222d";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (s.type === "box") {
      ctx.lineWidth = s.width || 3.6;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.restore();
      return;
    }

    const pts = s.points || [];
    if (pts.length === 0) {
      ctx.restore();
      return;
    }
    if (pts.length === 1) {
      ctx.fillStyle = s.color || "#18222d";
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, (s.width || 3.6) * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const pressure = p1.p && p1.p > 0 ? p1.p : 0.5;
      ctx.lineWidth = Math.max(1.2, (s.width || 3.6) * (0.65 + pressure * 0.7));
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function redraw() {
    canvas.width = LOGICAL_W;
    canvas.height = LOGICAL_H;
    drawRuledBackground();

    const page = getPage();
    const drawAllStrokes = () => {
      for (const s of page.strokes) {
        drawStroke(s);
      }
      if (activeStroke) drawStroke(activeStroke);
    };

    if (page.bgData) {
      let img = bgImageCache.get(page.bgData);
      if (img && img.complete) {
        const scale = Math.min((LOGICAL_W - 80) / img.width, (LOGICAL_H - 80) / img.height, 1);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (LOGICAL_W - dw) / 2, (LOGICAL_H - dh) / 2, dw, dh);
        drawAllStrokes();
      } else {
        img = new Image();
        img.onload = () => redraw();
        img.src = page.bgData;
        bgImageCache.set(page.bgData, img);
        drawAllStrokes();
      }
    } else {
      drawAllStrokes();
    }
  }

  function toLogicalPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * LOGICAL_W,
      y: ((e.clientY - rect.top) / rect.height) * LOGICAL_H,
      p: e.pressure || 0.5,
    };
  }

  function eraseStrokeAt(x, y) {
    const page = getPage();
    const threshold = 18;
    const beforeLen = page.strokes.length;
    page.strokes = page.strokes.filter((s) => {
      if (s.type === "box") {
        const minX = Math.min(s.x, s.x + s.w);
        const maxX = Math.max(s.x, s.x + s.w);
        const minY = Math.min(s.y, s.y + s.h);
        const maxY = Math.max(s.y, s.y + s.h);
        const nearHoriz = x >= minX - threshold && x <= maxX + threshold && (Math.abs(y - minY) < threshold || Math.abs(y - maxY) < threshold);
        const nearVert = y >= minY - threshold && y <= maxY + threshold && (Math.abs(x - minX) < threshold || Math.abs(x - maxX) < threshold);
        return !(nearHoriz || nearVert);
      }
      return !(s.points || []).some((pt) => Math.hypot(pt.x - x, pt.y - y) < threshold);
    });
    if (page.strokes.length !== beforeLen) {
      saveBooks();
      redraw();
    }
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("selectstart", (e) => e.preventDefault());
  canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const pos = toLogicalPos(e);
    drawing = true;

    if (tool === "eraser") {
      eraseStrokeAt(pos.x, pos.y);
      return;
    }

    redoStack = [];
    if (tool === "box") {
      activeStroke = { type: "box", color, width: lineWidth, x: pos.x, y: pos.y, w: 0, h: 0 };
    } else {
      activeStroke = { type: "pen", color, width: lineWidth, points: [pos] };
    }
    redraw();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const pos = toLogicalPos(e);
    if (tool === "eraser") {
      eraseStrokeAt(pos.x, pos.y);
      return;
    }
    if (!activeStroke) return;
    if (activeStroke.type === "box") {
      activeStroke.w = pos.x - activeStroke.x;
      activeStroke.h = pos.y - activeStroke.y;
    } else {
      activeStroke.points.push(pos);
    }
    redraw();
  });

  function finishPointer() {
    if (!drawing) return;
    drawing = false;
    if (activeStroke) {
      getPage().strokes.push(activeStroke);
      activeStroke = null;
      saveBooks();
      redraw();
    }
  }

  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);

  document.querySelectorAll("[data-note-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-note-tool]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      tool = btn.getAttribute("data-note-tool") || "pen";
      const c = btn.getAttribute("data-note-color");
      if (c) color = c;
    });
  });

  widthSelect?.addEventListener("change", () => {
    lineWidth = Number(widthSelect.value) || 3.6;
  });

  undoBtn?.addEventListener("click", () => {
    const page = getPage();
    if (page.strokes.length === 0) return;
    redoStack.push(page.strokes.pop());
    saveBooks();
    redraw();
  });

  redoBtn?.addEventListener("click", () => {
    if (redoStack.length === 0) return;
    getPage().strokes.push(redoStack.pop());
    saveBooks();
    redraw();
  });

  clearBtn?.addEventListener("click", () => {
    const page = getPage();
    page.strokes = [];
    page.bgData = "";
    redoStack = [];
    saveBooks();
    redraw();
  });

  bgBtn?.addEventListener("click", () => bgFileInput?.click());
  bgFileInput?.addEventListener("change", () => {
    const file = bgFileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      getPage().bgData = String(reader.result || "");
      saveBooks();
      redraw();
    };
    reader.readAsDataURL(file);
    bgFileInput.value = "";
  });

  prevPageBtn?.addEventListener("click", () => {
    if (currentPage > 0) {
      currentPage--;
      redoStack = [];
      renderBookSelect();
      redraw();
    }
  });

  nextPageBtn?.addEventListener("click", () => {
    if (currentPage < MAX_PAGES - 1) {
      currentPage++;
      redoStack = [];
      renderBookSelect();
      redraw();
    }
  });

  bookSelect?.addEventListener("change", () => {
    currentBookId = bookSelect.value;
    currentPage = 0;
    redoStack = [];
    renderBookSelect();
    redraw();
  });

  titleInput?.addEventListener("input", () => {
    getBook().title = titleInput.value;
    saveBooks();
    renderBookSelect();
  });

  newBookBtn?.addEventListener("click", () => {
    const nb = {
      id: String(Date.now()),
      title: `学習ノート ${books.length + 1}`,
      pages: makeEmptyPages(),
    };
    books.push(nb);
    currentBookId = nb.id;
    currentPage = 0;
    redoStack = [];
    saveBooks();
    renderBookSelect();
    redraw();
  });

  function exportPageDataUrl() {
    redraw();
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  askBtn?.addEventListener("click", () => {
    const imgUrl = exportPageDataUrl();
    const book = getBook();
    close();
    onAskWithImage(imgUrl, book.title || "AIノート", currentPage + 1);
  });

  ragBtn?.addEventListener("click", async () => {
    const imgUrl = exportPageDataUrl();
    const book = getBook();
    ragBtn.disabled = true;
    statusEl.textContent = "ノートを読み取り、RAGへ記憶中…";
    try {
      const res = await fetch("/api/note/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: book.title || "AIノート",
          page: currentPage + 1,
          image_data: imgUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "RAG登録に失敗しました。");
      statusEl.textContent = `RAGに記憶しました（単元: ${data.subject_tag}）`;
      onRagUpdated();
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : "エラーが発生しました";
    } finally {
      ragBtn.disabled = false;
    }
  });

  function open() {
    if (books.length === 0) loadBooks();
    statusEl.textContent = "";
    view.hidden = false;
    renderBookSelect();
    redraw();
  }

  function close() {
    view.hidden = true;
  }

  backBtn?.addEventListener("click", close);

  function listPages() {
    if (books.length === 0) loadBooks();
    const out = [];
    for (const b of books) {
      const pages = b.pages || [];
      pages.forEach((p, idx) => {
        const hasContent = Boolean((p.strokes && p.strokes.length > 0) || p.bgData);
        out.push({
          bookId: b.id,
          title: b.title || "無題ノート",
          pageIndex: idx,
          hasContent,
          strokeCount: (p.strokes || []).length,
        });
      });
    }
    return out;
  }

  function exportSpecificPage(bookId, pageIndex) {
    return new Promise((resolve) => {
      if (books.length === 0) loadBooks();
      const b = books.find((x) => x.id === bookId) || books[0];
      const page = (b.pages || [])[pageIndex] || { strokes: [], bgData: "" };

      const off = document.createElement("canvas");
      off.width = LOGICAL_W;
      off.height = LOGICAL_H;
      const octx = off.getContext("2d");

      // 罫線背景
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      octx.strokeStyle = "#e6edf7";
      octx.lineWidth = 1;
      for (let y = 64; y < LOGICAL_H; y += 44) {
        octx.beginPath();
        octx.moveTo(28, y);
        octx.lineTo(LOGICAL_W - 28, y);
        octx.stroke();
      }
      octx.strokeStyle = "#f4d5d5";
      octx.beginPath();
      octx.moveTo(84, 24);
      octx.lineTo(84, LOGICAL_H - 24);
      octx.stroke();

      const finish = () => {
        for (const s of page.strokes || []) {
          octx.save();
          octx.strokeStyle = s.color || "#18222d";
          octx.lineCap = "round";
          octx.lineJoin = "round";
          if (s.type === "box") {
            octx.lineWidth = s.width || 3.6;
            octx.strokeRect(s.x, s.y, s.w, s.h);
          } else {
            const pts = s.points || [];
            if (pts.length === 1) {
              octx.fillStyle = s.color || "#18222d";
              octx.beginPath();
              octx.arc(pts[0].x, pts[0].y, (s.width || 3.6) * 0.5, 0, Math.PI * 2);
              octx.fill();
            } else {
              for (let i = 1; i < pts.length; i++) {
                const p0 = pts[i - 1];
                const p1 = pts[i];
                const pressure = p1.p && p1.p > 0 ? p1.p : 0.5;
                octx.lineWidth = Math.max(1.2, (s.width || 3.6) * (0.65 + pressure * 0.7));
                octx.beginPath();
                octx.moveTo(p0.x, p0.y);
                octx.lineTo(p1.x, p1.y);
                octx.stroke();
              }
            }
          }
          octx.restore();
        }
        resolve(off.toDataURL("image/jpeg", 0.9));
      };

      if (page.bgData) {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min((LOGICAL_W - 80) / img.width, (LOGICAL_H - 80) / img.height, 1);
          const dw = img.width * scale;
          const dh = img.height * scale;
          octx.drawImage(img, (LOGICAL_W - dw) / 2, (LOGICAL_H - dh) / 2, dw, dh);
          finish();
        };
        img.onerror = finish;
        img.src = page.bgData;
      } else {
        finish();
      }
    });
  }

  loadBooks();
  return { open, close, setCallbacks, listPages, exportSpecificPage };
})();
