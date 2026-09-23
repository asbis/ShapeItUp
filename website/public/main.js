// shapeitup.dev — small, dependency-free interactions.
(() => {
  document.documentElement.classList.add("js");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Hero title: slide each line up ──────────────────────────────────
  const title = document.querySelector(".hero-title");
  if (title) {
    title.querySelectorAll(".line").forEach((line) => {
      const inner = document.createElement("span");
      while (line.firstChild) inner.append(line.firstChild);
      line.append(inner);
    });
    requestAnimationFrame(() => requestAnimationFrame(() => title.classList.add("in")));
    // rAF never fires in a background tab; don't leave the headline hidden.
    setTimeout(() => title.classList.add("in"), 400);
  }

  // ── Reveal on scroll ────────────────────────────────────────────────
  const revealables = document.querySelectorAll(
    ".sec-head, .h2, .sub, .way, .same-files, .loop-steps li, .loop-art > *, .tools, .vp-demo, .ops li, .comp-tree, .comp-copy, .stdlib, .pg-frame, .more-grid article, .compare, .install-grid > div, .stats > div",
  );
  if (!reduced && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -4% 0px" },
    );
    revealables.forEach((el, i) => {
      el.classList.add("reveal");
      // Stagger siblings in grids.
      const idx = Array.prototype.indexOf.call(el.parentElement?.children ?? [], el);
      el.style.transitionDelay = `${Math.min(idx, 8) * 45}ms`;
      io.observe(el);
    });
  }

  // ── Copy buttons ────────────────────────────────────────────────────
  document.querySelectorAll(".cmd .copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.closest(".cmd")?.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
        btn.classList.add("done");
      } catch {
        btn.textContent = "⌘C";
      }
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("done");
      }, 1600);
    });
  });

  // ── Tabs ────────────────────────────────────────────────────────────
  document.querySelectorAll("[data-tabs]").forEach((root) => {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const panels = [...root.querySelectorAll('[role="tabpanel"]')];
    tabs.forEach((t, i) =>
      t.addEventListener("click", () => {
        tabs.forEach((x, j) => x.setAttribute("aria-selected", String(i === j)));
        panels.forEach((p, j) => (p.hidden = i !== j));
      }),
    );
  });

  // ── Hero terminal: a replay of an agent session ─────────────────────
  // What the agent does is the product, so the hero shows it working —
  // including the step where the top view catches its own mistake.
  const term = document.getElementById("term");
  const SCRIPT = [
    { user: "Make an L-bracket, 60×40×50, 5 mm thick, with gussets and two M4 holes in each leg." },
    { tool: "create_shape", arg: "bracket.shape.ts", res: "✓ 52 lines" },
    { tool: "render_preview", arg: "top · front · right · iso", res: "✓ 60×40×50" },
    { say: "Top view: the gussets cover the base holes. Moving the holes inward." },
    { tool: "modify_shape", arg: "holeInset 12 → 15", res: "✓" },
    { tool: "verify_shape", arg: "bracket.shape.ts", res: "✓ 1 part" },
    { tool: "open_viewer", arg: "bracket.shape.ts", res: "→ :52341" },
    { say: "Done. Drag holeInset or gusset in the viewer. It's all in bracket.shape.ts." },
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toolRow(s) {
    const row = document.createElement("div");
    row.className = "t-tool";
    row.innerHTML =
      `<span class="dot">●</span><span class="name"></span><span class="arg"></span><span class="res"></span>`;
    row.querySelector(".name").textContent = s.tool;
    row.querySelector(".arg").textContent = s.arg;
    return row;
  }

  async function typeInto(el, text, speed) {
    el.classList.add("t-caret");
    for (let i = 1; i <= text.length; i++) {
      el.textContent = text.slice(0, i);
      await sleep(speed);
    }
    el.classList.remove("t-caret");
  }

  async function play() {
    for (;;) {
      term.innerHTML = "";
      for (const s of SCRIPT) {
        if (s.user) {
          const el = document.createElement("div");
          el.className = "t-user";
          term.append(el);
          await typeInto(el, s.user, 22);
          await sleep(500);
        } else if (s.tool) {
          const row = toolRow(s);
          term.append(row);
          const res = row.querySelector(".res");
          res.textContent = "…";
          await sleep(650);
          res.textContent = s.res;
          await sleep(260);
        } else if (s.say) {
          const el = document.createElement("div");
          el.className = "t-say";
          term.append(el);
          await typeInto(el, s.say, 14);
          await sleep(500);
        }
        term.scrollTop = term.scrollHeight;
      }
      await sleep(5200);
    }
  }

  function renderStatic() {
    term.innerHTML = "";
    for (const s of SCRIPT) {
      let el;
      if (s.user) (el = document.createElement("div")), (el.className = "t-user"), (el.textContent = s.user);
      else if (s.tool) (el = toolRow(s)), (el.querySelector(".res").textContent = s.res);
      else (el = document.createElement("div")), (el.className = "t-say"), (el.textContent = s.say);
      term.append(el);
    }
  }

  if (term) {
    if (reduced) renderStatic();
    else void play();
  }

  // ── Playground: boot the real kernel on request ─────────────────────
  // ~6 MB of WASM is too much to spend on a visit that never scrolls here,
  // so the iframe is created only when asked for.
  const boot = document.getElementById("pg-boot");
  boot?.addEventListener("click", () => {
    const frame = document.getElementById("pg-frame");
    const iframe = document.createElement("iframe");
    iframe.src = "app/?embed=1";
    iframe.title = "ShapeItUp playground";
    iframe.allow = "clipboard-write";
    frame.innerHTML = "";
    frame.append(iframe);
  });
})();
