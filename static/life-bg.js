(() => {
  const canvas = document.getElementById("bg-life-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const CELL = 34;
  const STEP_MS = 260;
  const WALKER_COUNT = 5;
  const TRAIL_PER_WALKER = 14;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const DIRS = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];

  let cols = 0;
  let rows = 0;
  let walkers = [];
  let sparks = [];
  let lastStep = 0;

  function createWalkers() {
    walkers = [];
    for (let i = 0; i < WALKER_COUNT; i++) {
      const x = 1 + Math.floor(Math.random() * Math.max(2, cols - 2));
      const y = 1 + Math.floor(Math.random() * Math.max(2, rows - 2));
      walkers.push({
        x,
        y,
        dir: Math.floor(Math.random() * DIRS.length),
        edges: [],
      });
    }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cols = Math.max(10, Math.floor(w / CELL));
    rows = Math.max(8, Math.floor(h / CELL));
    sparks = [];
    createWalkers();
  }

  function addSpark(px, py) {
    // 同じ場所での連続重複を防ぐ
    if (sparks.some((s) => Math.hypot(s.x - px, s.y - py) < 8 && s.age < 0.35)) {
      return;
    }
    sparks.push({ x: px, y: py, age: 0, maxAge: 1.0 });
    if (sparks.length > 16) {
      sparks.shift();
    }
  }

  function stepAllWalkers() {
    // 移動中の「点（先頭）」同士の衝突だけを見る
    const prevHeads = walkers.map((w) => ({ x: w.x, y: w.y }));
    const nextPositions = new Map();

    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i];
      // 今と同じ方向（直進）へ進む確率を大幅に上げる（直進80% / 左右各10%）
      const roll = Math.random();
      if (roll < 0.10) {
        w.dir = (w.dir + 1) % DIRS.length;
      } else if (roll < 0.20) {
        w.dir = (w.dir + DIRS.length - 1) % DIRS.length;
      }

      let nx = w.x + DIRS[w.dir][0];
      let ny = w.y + DIRS[w.dir][1];

      if (nx < 1 || nx >= cols - 1 || ny < 1 || ny >= rows - 1) {
        w.dir = (w.dir + 2) % DIRS.length;
        nx = Math.max(1, Math.min(cols - 2, w.x + DIRS[w.dir][0]));
        ny = Math.max(1, Math.min(rows - 2, w.y + DIRS[w.dir][1]));
      }

      const x1 = w.x * CELL + CELL * 0.5;
      const y1 = w.y * CELL + CELL * 0.5;
      const x2 = nx * CELL + CELL * 0.5;
      const y2 = ny * CELL + CELL * 0.5;

      w.edges.push({ x1, y1, x2, y2, gx: nx, gy: ny });
      if (w.edges.length > TRAIL_PER_WALKER) {
        w.edges.shift();
      }

      // 点と点が同じマスに到達、またはすれ違い衝突したときだけ黄色く光る
      const key = `${nx},${ny}`;
      const sameCellHit = nextPositions.has(key);
      const swapHit = prevHeads.some(
        (p, j) => j !== i && p.x === nx && p.y === ny && walkers[j].x === w.x && walkers[j].y === w.y
      );
      if (sameCellHit || swapHit) {
        addSpark(x2, y2);
        w.dir = (w.dir + 1) % DIRS.length;
      }

      w.x = nx;
      w.y = ny;
      nextPositions.set(key, i);
    }
  }

  function draw(now) {
    if (!lastStep) lastStep = now;
    const elapsed = now - lastStep;

    if (!reducedMotion && elapsed >= STEP_MS) {
      stepAllWalkers();
      lastStep = now;
    }

    const progress = reducedMotion ? 1 : Math.min(1, (now - lastStep) / STEP_MS);

    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.lineCap = "round";

    for (const w of walkers) {
      const total = w.edges.length;
      for (let i = 0; i < total; i++) {
        const e = w.edges[i];
        const isHead = i === total - 1;
        const t = isHead ? progress : 1;
        const ex = e.x1 + (e.x2 - e.x1) * t;
        const ey = e.y1 + (e.y2 - e.y1) * t;

        const ratio = (i + 1) / Math.max(1, total);
        const alpha = 0.05 + ratio * 0.22;

        ctx.strokeStyle = `rgba(37, 99, 235, ${alpha.toFixed(3)})`;
        ctx.lineWidth = isHead ? 1.8 : 1.3;
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        if (isHead) {
          ctx.fillStyle = "rgba(37, 99, 235, 0.45)";
          ctx.beginPath();
          ctx.arc(ex, ey, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 衝突・接続した瞬間の小さな黄色い発光
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.age += 0.024;
      if (s.age >= s.maxAge) {
        sparks.splice(i, 1);
        continue;
      }
      const fade = 1 - s.age / s.maxAge;
      const radius = 5 + (1 - fade) * 7;
      const grad = ctx.createRadialGradient(s.x, s.y, 0.5, s.x, s.y, radius);
      grad.addColorStop(0, `rgba(250, 204, 21, ${(fade * 0.72).toFixed(3)})`);
      grad.addColorStop(0.55, `rgba(245, 158, 11, ${(fade * 0.26).toFixed(3)})`);
      grad.addColorStop(1, "rgba(245, 158, 11, 0)");

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(254, 240, 138, ${(fade * 0.9).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!reducedMotion) {
      requestAnimationFrame(draw);
    }
  }

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(draw);
})();
