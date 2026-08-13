(function () {
  const state = {
    nav: "ask",
    workspace: "clinops",
    enabled: {
      veeva: true,
      imednet: true,
      medidata: true,
      ctgov: true,
      insightsrm: true,
      netsuite: true,
      trialhub: false,
      salesforce: false
    },
    draft: "",
    phase: "idle",
    key: "live",
    askedText: "",
    error: "",
    traceOpen: false,
    chart: null,
    history: load("odl.history", []),
    saved: load("odl.saved", [])
  };

  const NAV = [
    { key: "ask", label: "Ask", icon: "search" },
    { key: "saved", label: "Saved answers", icon: "file" },
    { key: "sources", label: "Sources", icon: "database" },
    { key: "history", label: "History", icon: "clipboard" }
  ];

  const CONF = {
    high: { label: "High confidence — all required sources in scope", bg: "var(--status-success-bg)", color: "var(--ora-teal-600)" },
    medium: { label: "Medium confidence — registry data lags by up to 2 weeks", bg: "var(--status-info-bg)", color: "var(--ora-blue-600)" },
    partial: { label: "Partial answer — a required source is switched off", bg: "var(--status-warning-bg)", color: "var(--ora-amber-500)" }
  };

  function load(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function sourceById(id) {
    return SOURCES.find((s) => s.id === id);
  }

  function enabledList() {
    return SOURCES.filter((s) => state.enabled[s.id]);
  }

  function guessKey(text) {
    const t = (text || "").toLowerCase();
    const competitive = ["competitor", "sponsor", "registry", "market", "poland", "cac", "pipeline", "bid"];
    if (competitive.some((w) => t.includes(w))) return "competitive";
    const staffing = ["staff", "resource", "cra", "fte", "capacity", "assign", "backfill", "rolls off", "headcount"];
    if (staffing.some((w) => t.includes(w))) return "staffing";
    return "enrollment";
  }

  function setNav(key) {
    state.nav = key;
    render();
  }

  function resetAsk() {
    state.phase = "idle";
    state.draft = "";
    state.traceOpen = false;
    state.nav = "ask";
    render();
    const el = document.getElementById("draft");
    if (el) el.value = "";
  }

  async function run(_key, text) {
    const question = (text || state.draft || "").trim();
    if (!question) return;
    state.nav = "ask";
    state.phase = "thinking";
    state.key = "live";
    state.askedText = question;
    state.draft = "";
    state.error = "";
    state.traceOpen = false;
    state.answer = null;
    render();

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          sources: enabledList().map((s) => s.id)
        })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Ask failed (${res.status})`);
      }
      if (!body.answer) throw new Error("API returned no answer");
      state.answer = body.answer;
      state.phase = "answered";
      state.history.unshift({ at: new Date().toISOString(), text: question, key: "live" });
      state.history = state.history.slice(0, 40);
      save("odl.history", state.history);
    } catch (err) {
      state.phase = "error";
      state.error = String(err.message || err);
    }
    render();
  }

  function missingFor(answer) {
    return (answer.needs || []).filter((id) => !state.enabled[id]);
  }

  function renderNav() {
    const root = document.getElementById("nav");
    root.innerHTML =
      '<div class="nav-label">Data Lens</div>' +
      NAV.map(
        (n) =>
          `<button type="button" class="nav-btn${state.nav === n.key ? " active" : ""}" data-nav="${n.key}">${ICONS[n.icon]}<span>${n.label}</span></button>`
      ).join("");
    root.querySelectorAll("[data-nav]").forEach((btn) => {
      btn.onclick = () => setNav(btn.dataset.nav);
    });
  }

  function renderSources() {
    document.getElementById("enabledSummary").textContent = enabledList().length
      ? enabledList().map((s) => s.name).join(" · ")
      : "No sources selected — pick at least one to ask a question.";
    document.getElementById("enabledCount").textContent = `${enabledList().length} of ${SOURCES.length} sources in scope`;
    document.getElementById("scopeLine").textContent = `${enabledList().length} sources · synced within the hour`;

    document.getElementById("workspaces").innerHTML = WORKSPACES.map(
      (w) =>
        `<button type="button" class="chip${state.workspace === w.id ? " active" : ""}" data-ws="${w.id}">${w.label}</button>`
    ).join("");
    document.querySelectorAll("[data-ws]").forEach((btn) => {
      btn.onclick = () => {
        const w = WORKSPACES.find((x) => x.id === btn.dataset.ws);
        SOURCES.forEach((s) => {
          state.enabled[s.id] = w.ids.includes(s.id);
        });
        state.workspace = w.id;
        render();
      };
    });

    document.getElementById("sourceList").innerHTML = SOURCES.map((s) => {
      const on = state.enabled[s.id];
      return `<button type="button" class="source-card${on ? " on" : ""}" data-src="${s.id}">
        <span class="check">${on ? "✓" : ""}</span>
        <span style="min-width:0;flex:1">
          <span class="source-top"><span class="source-name">${s.name}</span><span class="source-sync${s.fresh ? "" : " stale"}">${s.sync}</span></span>
          <span class="source-cat">${s.cat}</span>
          <span class="source-scope">${s.scope}</span>
        </span>
      </button>`;
    }).join("");
    document.querySelectorAll("[data-src]").forEach((btn) => {
      btn.onclick = () => {
        state.enabled[btn.dataset.src] = !state.enabled[btn.dataset.src];
        state.workspace = null;
        render();
      };
    });
  }

  function renderIdle() {
    const panel = document.getElementById("idlePanel");
    panel.classList.toggle("hidden", state.phase !== "idle");
    if (state.phase !== "idle") return;
    panel.innerHTML =
      `<div class="suggest-head">Start from</div>` +
      EXAMPLE_QUESTIONS.map(
        (q) => `<button type="button" class="suggest">
            <span class="suggest-icon">${ICONS[q.icon]}</span>
            <span><span class="suggest-text">${q.text}</span><span class="suggest-needs">${q.needs}</span></span>
          </button>`
      ).join("");
    panel.querySelectorAll(".suggest").forEach((btn, i) => {
      btn.onclick = () => run("live", EXAMPLE_QUESTIONS[i].text);
    });
  }

  function renderThinking() {
    const panel = document.getElementById("thinkingPanel");
    panel.classList.toggle("hidden", state.phase !== "thinking");
    panel.innerHTML = `<div class="thinking">
      <div class="thinking-row"><span class="dot"></span><span>Reading ${enabledList().length} sources</span></div>
      <div class="skel" style="width:72%"></div>
      <div class="skel" style="width:94%"></div>
      <div class="skel" style="width:48%"></div>
    </div>`;
  }

  function renderAnswer() {
    const panel = document.getElementById("answerPanel");
    if (state.phase === "error") {
      panel.classList.remove("hidden");
      panel.innerHTML = `<div class="you"><span class="you-badge">You</span><p>${escapeHtml(state.askedText)}</p></div>
        <div class="gap"><div style="flex:1">
          <div class="gap-title">Could not answer from Cosmos</div>
          <div class="gap-body">${escapeHtml(state.error)}</div>
        </div></div>`;
      return;
    }
    const show = state.phase === "answered" && state.answer;
    panel.classList.toggle("hidden", !show);
    if (!show) {
      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      }
      return;
    }

    const a = state.answer;
    const missing = missingFor(a);
    const missingNames = missing.map((id) => sourceById(id).name);
    const confKey = missing.length ? "partial" : a.confidence;
    const conf = CONF[confKey];

    const gap = missing.length
      ? `<div class="gap">
          <div style="flex:1">
            <div class="gap-title">${missingNames.join(" and ")} ${missing.length > 1 ? "are" : "is"} switched off</div>
            <div class="gap-body">This answer leaves out ${missingNames.join(" and ")}, so anything sourced from ${missing.length > 1 ? "them" : "it"} is missing rather than zero.</div>
          </div>
          <button type="button" class="gap-btn" id="fixGap">Add and re-run</button>
        </div>`
      : "";

    const bars = (a.bars || [])
      .map(
        (b) => `<div class="bar-row">
          <span class="bar-label">${b.label}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${b.pct}%;background:${b.color}"></span></span>
          <span class="bar-val">${b.value}</span>
        </div>`
      )
      .join("");

    const cols = a.cols
      .map((c) => `<span>${c}</span>`)
      .join("");
    const rows = a.rows
      .map(
        (r) =>
          `<div class="table-row" style="grid-template-columns:${a.grid}">${r
            .map((cell, i) => `<span class="${i === 0 ? "cell-strong" : i < 3 ? "cell-mono" : ""}">${cell}</span>`)
            .join("")}</div>`
      )
      .join("");

    const cites = a.needs
      .filter((id) => state.enabled[id])
      .map(
        (id) => `<span class="cite"><span class="cite-dot" style="background:${DOT[id]}"></span><span class="cite-name">${sourceById(id).name}</span><span class="cite-detail">${DETAIL[id]}</span></span>`
      )
      .join("");

    const trace = state.traceOpen
      ? a.trace
          .map((t, i) => `<div class="trace-step"><span class="trace-n">${i + 1}</span><span>${t}</span></div>`)
          .join("") + `<pre class="trace-sql">${a.query}</pre>`
      : "";

    const follows = (a.followUps || [])
      .map((f) => `<button type="button" class="follow">${f}</button>`)
      .join("");

    panel.innerHTML = `
      <div class="you"><span class="you-badge">You</span><p>${escapeHtml(state.askedText)}</p></div>
      ${gap}
      <div class="answer">
        <div class="answer-head">
          <span class="conf" style="background:${conf.bg};color:${conf.color}"><span class="conf-dot" style="background:${conf.color}"></span>${conf.label}</span>
          <span class="chart-note">${a.chartNote}</span>
        </div>
        <p class="summary">${a.summary}</p>
        <div class="block">
          <span class="block-title">${a.chartTitle}</span>
          <div class="chart-wrap"><canvas id="odlChart"></canvas></div>
          <div class="bars">${bars}</div>
        </div>
        <div class="block">
          <span class="block-title">${a.tableTitle}</span>
          <div class="table-wrap">
            <div class="table-head" style="grid-template-columns:${a.grid}">${cols}</div>
            ${rows}
          </div>
        </div>
        <div class="block">
          <span class="suggest-head">Where this came from</span>
          <div class="cites">${cites}</div>
          <div class="caveat">${a.caveat}</div>
        </div>
        <div class="block" style="padding-top:14px">
          <button type="button" class="trace-btn" id="toggleTrace">${state.traceOpen ? "Hide how this was answered" : "Show how this was answered"}</button>
          ${trace}
        </div>
      </div>
      <div>
        <div class="suggest-head" style="margin-bottom:10px">Follow up</div>
        <div class="follows">${follows}</div>
      </div>`;

    const fix = document.getElementById("fixGap");
    if (fix) {
      fix.onclick = () => {
        missing.forEach((id) => {
          state.enabled[id] = true;
        });
        state.workspace = null;
        run(state.key, state.askedText);
      };
    }
    const tog = document.getElementById("toggleTrace");
    if (tog) tog.onclick = () => {
      state.traceOpen = !state.traceOpen;
      render();
    };
    panel.querySelectorAll(".follow").forEach((btn) => {
      btn.onclick = () => run(guessKey(btn.textContent), btn.textContent);
    });

    drawChart(a);
  }

  function drawChart(a) {
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    const canvas = document.getElementById("odlChart");
    if (!canvas || typeof Chart === "undefined" || !a.bars || !a.bars.length) return;
    state.chart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: a.bars.map((b) => b.label),
        datasets: [
          {
            data: a.bars.map((b) => b.pct),
            backgroundColor: a.bars.map((b) => b.color),
            borderRadius: 8,
            barThickness: 18
          }
        ]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            max: 112,
            grid: { color: "#e3e4e6" },
            ticks: { color: "#63666b", font: { family: "Roboto Mono", size: 11 } }
          },
          y: {
            grid: { display: false },
            ticks: { color: "#052c49", font: { family: "Roboto", size: 12 } }
          }
        }
      }
    });
  }

  function renderLists() {
    const saved = document.getElementById("viewSaved");
    const hist = document.getElementById("viewHistory");
    const help = document.getElementById("viewSourcesHelp");
    const ask = document.getElementById("viewAsk");

    ask.classList.toggle("hidden", state.nav !== "ask");
    saved.classList.toggle("hidden", state.nav !== "saved");
    hist.classList.toggle("hidden", state.nav !== "history");
    help.classList.toggle("hidden", state.nav !== "sources");

    const titles = {
      ask: "Ask your data",
      saved: "Saved answers",
      history: "History",
      sources: "Sources"
    };
    document.getElementById("pageTitle").textContent = titles[state.nav];

    saved.innerHTML = state.saved.length
      ? `<div class="suggest-head">Pinned</div>` +
        state.saved
          .map(
            (s, i) =>
              `<button type="button" class="list-card" data-saved="${i}"><strong>${escapeHtml(s.text)}</strong><div class="list-meta">${s.at} · ${s.key}</div></button>`
          )
          .join("")
      : `<p class="empty">No saved views yet. Run a question, then use Save this view.</p>`;
    saved.querySelectorAll("[data-saved]").forEach((btn) => {
      btn.onclick = () => {
        const s = state.saved[Number(btn.dataset.saved)];
        run(s.key, s.text);
      };
    });

    hist.innerHTML = state.history.length
      ? `<div class="suggest-head">Recent</div>` +
        state.history
          .map(
            (s, i) =>
              `<button type="button" class="list-card" data-hist="${i}"><strong>${escapeHtml(s.text)}</strong><div class="list-meta">${s.at}</div></button>`
          )
          .join("")
      : `<p class="empty">Nothing asked yet.</p>`;
    hist.querySelectorAll("[data-hist]").forEach((btn) => {
      btn.onclick = () => {
        const s = state.history[Number(btn.dataset.hist)];
        run(s.key, s.text);
      };
    });

    help.innerHTML = `<div class="answer">
      <p class="summary">Same Cosmos as Study Bid Workbench: database <code>bd-budgets</code>. Ask reads existing <code>ora_fact_study</code> / TrialHub / CT.gov. Daily gold sync writes only <code>lens_*</code> containers — never the bid <code>studies</code> docs.</p>
      <p class="caveat">Ask hits <code>/api/ask</code> → Cosmos <code>bd-budgets</code> read-only. No canned answers.</p>
    </div>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bindChrome() {
    const draft = document.getElementById("draft");
    draft.value = state.draft;
    draft.oninput = (e) => {
      state.draft = e.target.value;
    };
    draft.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const t = state.draft.trim();
        if (t) run(guessKey(t), t);
      }
    };
    document.getElementById("btnAsk").onclick = () => {
      const t = state.draft.trim();
      if (t) run("live", t);
    };
    document.getElementById("btnNew").onclick = resetAsk;
    document.getElementById("btnSave").onclick = () => {
      if (state.phase !== "answered") return;
      state.saved.unshift({ at: new Date().toISOString(), text: state.askedText, key: state.key });
      state.saved = state.saved.slice(0, 30);
      save("odl.saved", state.saved);
      setNav("saved");
    };
  }

  function render() {
    renderNav();
    renderSources();
    renderIdle();
    renderThinking();
    renderAnswer();
    renderLists();
    bindChrome();
  }

  render();
})();
