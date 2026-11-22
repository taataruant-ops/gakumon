window.RagSpace = (() => {
  const view = document.getElementById("rag-view");
  const canvas = document.getElementById("rag-canvas");
  const emptyOverlay = document.getElementById("rag-empty-overlay");
  const detailCard = document.getElementById("rag-detail-card");
  const detailTag = document.getElementById("rag-detail-tag");
  const detailSim = document.getElementById("rag-detail-sim");
  const detailDate = document.getElementById("rag-detail-date");
  const detailQuestion = document.getElementById("rag-detail-question");
  const detailAnswer = document.getElementById("rag-detail-answer");
  const detailClose = document.getElementById("rag-detail-close");

  const backBtn = document.getElementById("rag-back-btn");
  const regatherBtn = document.getElementById("rag-regather-btn");
  const zoomInBtn = document.getElementById("rag-zoom-in-btn");
  const zoomOutBtn = document.getElementById("rag-zoom-out-btn");
  const zoomResetBtn = document.getElementById("rag-zoom-reset-btn");

  if (!view || !canvas) return { open: () => {}, close: () => {} };
  const ctx = canvas.getContext("2d");

  let rafId = 0;
  let nodes = [];
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let hoveredUid = null;
  let selectedUid = null;
  let renderMarkdownFn = (t) => t;

  function setMarkdownRenderer(fn) {
    renderMarkdownFn = fn;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function scatterNodes() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;

    for (const n of nodes) {
      n.px = (Math.random() - 0.5) * w * 0.85;
      n.py = (Math.random() - 0.5) * h * 0.85;
      n.vx = (Math.random() - 0.5) * 2.5;
      n.vy = (Math.random() - 0.5) * 2.5;
    }
  }

  function worldToScreen(wx, wy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.width * 0.5 + panX + wx * zoom,
      y: rect.height * 0.5 + panY + wy * zoom,
    };
  }

  function screenToWorld(sx, sy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (sx - rect.width * 0.5 - panX) / zoom,
      y: (sy - rect.height * 0.5 - panY) / zoom,
    };
  }

  function showDetail(node) {
    selectedUid = node.uid;
    detailTag.textContent = node.subject_tag || "未分類";
    const pct = Math.round((node.similarity_to_latest || 0) * 100);
    detailSim.textContent = node.is_latest ? "最新の質問（基準）" : `基準との類似度 ${pct}%`;
    detailDate.textContent = node.created_at || "";
    detailQuestion.textContent = node.question_text || "";
    detailAnswer.innerHTML = renderMarkdownFn(node.explanation || node.key_point || "");
    if (typeof window.renderMathInElement === "function") {
      try {
        window.renderMathInElement(detailAnswer, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
          ],
          throwOnError: false,
        });
      } catch {}
    }
    detailCard.hidden = false;
  }

  function drawFrame() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const spread = Math.min(w, h) * 0.4;

    ctx.clearRect(0, 0, w, h);

    // 各質問ノード自身の位置を磁力吸引で更新（飾りの砂鉄は無し）
    for (const n of nodes) {
      const tx = n.x * spread;
      const ty = n.y * spread;
      const dx = tx - n.px;
      const dy = ty - n.py;

      const pull = 0.065;
      n.vx = (n.vx + dx * pull - dy * 0.004) * 0.80;
      n.vy = (n.vy + dy * pull + dx * 0.004) * 0.80;
      n.px += n.vx;
      n.py += n.vy;
    }

    const anchorNode = nodes.find((n) => n.is_latest);
    const center = anchorNode
      ? worldToScreen(anchorNode.px, anchorNode.py)
      : worldToScreen(0, 0);

    // 類似度が高い質問同士を薄い線で結ぶ
    for (const n of nodes) {
      if (n.is_latest) continue;
      if ((n.similarity_to_latest || 0) < 0.55) continue;
      const p = worldToScreen(n.px, n.py);
      ctx.strokeStyle = `rgba(37, 99, 235, ${((n.similarity_to_latest - 0.4) * 0.35).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    // 質問の点とラベルを描画
    ctx.textAlign = "center";
    for (const n of nodes) {
      const p = worldToScreen(n.px, n.py);
      const isSelected = n.uid === selectedUid;
      const isHovered = n.uid === hoveredUid;

      ctx.beginPath();
      ctx.arc(p.x, p.y, (n.is_latest ? 7 : 5.5) * Math.min(1.5, Math.max(0.9, zoom)), 0, Math.PI * 2);
      ctx.fillStyle = n.is_latest ? "#f59e0b" : isSelected ? "#1d4ed8" : "#334155";
      ctx.fill();

      if (isSelected || isHovered || n.is_latest) {
        ctx.strokeStyle = n.is_latest ? "rgba(245, 158, 11, 0.45)" : "rgba(29, 78, 216, 0.35)";
        ctx.lineWidth = 4;
        ctx.stroke();
      }

      if (zoom >= 1.12 || isHovered || isSelected || n.is_latest) {
        const title = n.is_latest
          ? `【基準】${n.subject_tag}`
          : `${n.subject_tag} (${Math.round((n.similarity_to_latest || 0) * 100)}%)`;
        ctx.font = "700 12px 'Noto Sans JP', sans-serif";
        ctx.fillStyle = "rgba(24, 34, 45, 0.9)";
        ctx.fillText(title, p.x, p.y - 14);

        if (zoom >= 1.45 || isHovered || isSelected) {
          const shortQ = n.question_text.length > 20 ? n.question_text.slice(0, 20) + "…" : n.question_text;
          ctx.font = "400 11px 'Noto Sans JP', sans-serif";
          ctx.fillStyle = "rgba(85, 101, 117, 0.95)";
          ctx.fillText(shortQ, p.x, p.y + 18);
        }
      }
    }

    if (!view.hidden) {
      rafId = requestAnimationFrame(drawFrame);
    }
  }

  function findHitNode(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let best = null;
    let bestDist = 26;

    for (const n of nodes) {
      const p = worldToScreen(n.px, n.py);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  async function open() {
    view.hidden = false;
    detailCard.hidden = true;
    selectedUid = null;
    zoom = 1;
    panX = 0;
    panY = 0;
    resize();

    try {
      const res = await fetch("/api/rag/map");
      const data = await res.json();
      nodes = data.nodes || [];
    } catch {
      nodes = [];
    }

    emptyOverlay.hidden = nodes.length > 0;
    scatterNodes();

    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(drawFrame);
  }

  function close() {
    view.hidden = true;
    cancelAnimationFrame(rafId);
  }

  backBtn?.addEventListener("click", close);
  detailClose?.addEventListener("click", () => {
    detailCard.hidden = true;
    selectedUid = null;
  });

  regatherBtn?.addEventListener("click", scatterNodes);

  zoomInBtn?.addEventListener("click", () => {
    zoom = Math.min(4.5, zoom * 1.25);
  });

  zoomOutBtn?.addEventListener("click", () => {
    zoom = Math.max(0.45, zoom / 1.25);
  });

  zoomResetBtn?.addEventListener("click", () => {
    zoom = 1;
    panX = 0;
    panY = 0;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);

    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoom = Math.min(4.5, Math.max(0.45, zoom * factor));

    const afterX = rect.width * 0.5 + panX + before.x * zoom;
    const afterY = rect.height * 0.5 + panY + before.y * zoom;
    panX += sx - afterX;
    panY += sy - afterY;
  }, { passive: false });

  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX - panX;
    dragStartY = e.clientY - panY;
  });

  window.addEventListener("mousemove", (e) => {
    if (view.hidden) return;
    if (dragging) {
      const nx = e.clientX - dragStartX;
      const ny = e.clientY - dragStartY;
      if (Math.hypot(nx - panX, ny - panY) > 3) dragMoved = true;
      panX = nx;
      panY = ny;
      return;
    }
    const hit = findHitNode(e.clientX, e.clientY);
    hoveredUid = hit ? hit.uid : null;
    canvas.style.cursor = hit ? "pointer" : "grab";
  });

  window.addEventListener("mouseup", (e) => {
    if (!dragging) return;
    dragging = false;
    if (!dragMoved) {
      const hit = findHitNode(e.clientX, e.clientY);
      if (hit) showDetail(hit);
    }
  });

  // タブレット・スマホ向け：1本指ドラッグ移動・タップ選択 ＋ 2本指ピンチ拡大縮小
  let pinchActive = false;
  let lastPinchDist = 0;
  let touchMoved = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  canvas.addEventListener("touchstart", (e) => {
    if (view.hidden) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      pinchActive = true;
      dragging = false;
      touchMoved = true;
      const [t1, t2] = e.touches;
      lastPinchDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY) || 1;
    } else if (e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      pinchActive = false;
      dragging = true;
      touchMoved = false;
      touchStartX = t.clientX - panX;
      touchStartY = t.clientY - panY;
      lastTapX = t.clientX;
      lastTapY = t.clientY;
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    if (view.hidden) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const rect = canvas.getBoundingClientRect();
      const midX = (t1.clientX + t2.clientX) * 0.5;
      const midY = (t1.clientY + t2.clientY) * 0.5;
      const curDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY) || 1;

      if (!pinchActive) {
        pinchActive = true;
        lastPinchDist = curDist;
        return;
      }

      const sx = midX - rect.left;
      const sy = midY - rect.top;
      const before = screenToWorld(sx, sy);

      const scaleFactor = curDist / Math.max(1, lastPinchDist);
      zoom = Math.min(4.5, Math.max(0.45, zoom * scaleFactor));
      lastPinchDist = curDist;

      const afterX = rect.width * 0.5 + panX + before.x * zoom;
      const afterY = rect.height * 0.5 + panY + before.y * zoom;
      panX += sx - afterX;
      panY += sy - afterY;
      touchMoved = true;
    } else if (e.touches.length === 1 && dragging && !pinchActive) {
      e.preventDefault();
      const t = e.touches[0];
      const nx = t.clientX - touchStartX;
      const ny = t.clientY - touchStartY;
      if (Math.hypot(nx - panX, ny - panY) > 6) touchMoved = true;
      panX = nx;
      panY = ny;
      lastTapX = t.clientX;
      lastTapY = t.clientY;
    }
  }, { passive: false });

  canvas.addEventListener("touchend", (e) => {
    if (view.hidden) return;
    if (e.touches.length === 1) {
      // 2本指から1本指に戻ったときはジャンプせずそのままパン継続
      const t = e.touches[0];
      pinchActive = false;
      dragging = true;
      touchMoved = true;
      touchStartX = t.clientX - panX;
      touchStartY = t.clientY - panY;
      return;
    }
    if (e.touches.length === 0) {
      const wasTap = dragging && !pinchActive && !touchMoved;
      dragging = false;
      pinchActive = false;
      if (wasTap) {
        const hit = findHitNode(lastTapX, lastTapY);
        if (hit) showDetail(hit);
      }
    }
  }, { passive: false });

  canvas.addEventListener("touchcancel", () => {
    dragging = false;
    pinchActive = false;
  });

  window.addEventListener("resize", () => {
    if (!view.hidden) resize();
  });

  return { open, close, setMarkdownRenderer };
})();
