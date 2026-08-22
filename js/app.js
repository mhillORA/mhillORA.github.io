(function () {
  const state = {
    nav: "ask",
    purpose: load("odl.purpose", "clinops") || "clinops",
    workspace: "clinops",
    enabled: {
      ora: true,
      ctgov: true,
      trialhub: true,
      salesforce: false,
      veeva: false,
      imednet: false,
      medidata: false,
      insightsrm: false,
      netsuite: true
    },
    briefing: null,
    finance: null,
    rm: null,
    rmPeople: null,
    rmPersonId: "",
    rmPeopleFilter: "",
    rmPeopleError: "",
    rmDateFrom: "",
    rmDateTo: "",
    rmOpen: {},
    rmOpenStaff: {},
    rmStudy: "",
    rmRole: "",
    rmPosition: "",
    rmDept: "",
    rmActivity: "",
    rmLayer: "study",
    rmView: "tree",
    project: null,
    projectNumber: "",
    projectFilter: "",
    projectError: "",
    mobileDrawer: null,
    sourcesOpen: load("odl.sourcesOpen", false),
    draft: "",
    phase: "idle",
    key: "live",
    askedText: "",
    error: "",
    traceOpen: false,
    chart: null,
    history: load("odl.history", []),
    saved: load("odl.saved", []),
    viewer: null,
    viewerError: "",
    extraDraft: "",
    notesDraft: "",
    savingContext: false,
    thread: []
  };

  const NAV = [
    { key: "ask", label: "Ask", icon: "search" },
    { key: "rm", label: "RM", icon: "users" },
    { key: "context", label: "My context", icon: "user" },
    { key: "saved", label: "Saved answers", icon: "file" },
    { key: "sources", label: "Sources", icon: "database" },
    { key: "history", label: "History", icon: "clipboard" }
  ];

  const CONF = {
    high: { label: "High confidence — all required sources in scope", bg: "var(--status-success-bg)", color: "var(--ora-teal-600)" },
    medium: { label: "Medium confidence — registry data lags by up to 2 weeks", bg: "var(--status-info-bg)", color: "var(--ora-blue-600)" },
    partial: { label: "Partial answer — a needed source is out of scope", bg: "var(--status-warning-bg)", color: "var(--ora-amber-500)" }
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

  function loadedSources() {
    return SOURCES.filter((s) => s.loaded);
  }

  function enabledList() {
    return SOURCES.filter((s) => s.loaded && state.enabled[s.id]);
  }

  function guessKey(text) {
    const t = (text || "").toLowerCase();
    if (/\b(netsuite|profitability|gross margin|\bgm\b|change order|billable)\b/.test(t)) return "netsuite";
    if (/\b(sites?|investigator|scorecard|site psm)\b/.test(t) && !/\bvisits?\b/.test(t)) return "sites";
    const competitive = ["competitor", "sponsor", "registry", "market", "poland", "cac", "pipeline", "bid"];
    if (competitive.some((w) => t.includes(w))) return "competitive";
    const staffing = ["staff", "resource", "cra", "fte", "capacity", "assign", "backfill", "rolls off", "headcount", "over-allocated", "overallocated", "allocation"];
    if (staffing.some((w) => t.includes(w))) return "staffing";
    return "enrollment";
  }

  function fmtPct(n) {
    if (n == null || n === "") return "—";
    return `${Math.round(Number(n) * 1000) / 10}%`;
  }

  function fmtMoney(n) {
    if (n == null || n === "") return "—";
    return `$${Math.round(Number(n))}`;
  }

  function gmClass(n) {
    if (n == null) return "missing";
    return n < 0 ? "under" : "over";
  }

  function cssToken(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function chartBarColor(color) {
    const c = String(color || "").trim().toLowerCase();
    if (currentTheme() !== "dark") return color || cssToken("--chart-1", "#052c49");
    const navy = new Set(["#052c49", "#001123", "#032039", "#0a3f66", "#0a314c", "#052c49ff"]);
    const blue = new Set(["#273b8a", "#1d2c68", "#273b8aff"]);
    if (!c || navy.has(c)) return cssToken("--chart-1", "#3ebdac");
    if (blue.has(c)) return cssToken("--chart-2", "#7eb8ff");
    return color;
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function applyTheme(theme, persist) {
    const next = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    if (persist) save("odl.theme", next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next === "dark" ? "#001123" : "#052c49");
    const label = next === "dark" ? "Ora Data Lens, switch to light mode" : "Ora Data Lens, switch to dark mode";
    ["brandHome", "mobileBrandHome"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
      el.setAttribute("aria-label", label);
      el.title = next === "dark" ? "Switch to light mode" : "Switch to dark mode";
    });
  }

  function toggleTheme() {
    applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
    render();
  }

  function purposeOf(id) {
    return (typeof PURPOSES !== "undefined" ? PURPOSES : []).find((p) => p.id === id);
  }

  function applyPurposeSources(id) {
    const p = purposeOf(id);
    if (!p) return;
    SOURCES.forEach((s) => {
      state.enabled[s.id] = s.loaded && p.ids.includes(s.id);
    });
    state.workspace = p.workspace;
    state.purpose = p.id;
  }

  function setPurpose(id, opts) {
    const keepIdle = !(opts && opts.keepView);
    applyPurposeSources(id);
    save("odl.purpose", id);
    if (keepIdle) {
      state.phase = "idle";
      state.project = null;
      state.projectNumber = "";
      state.projectError = "";
      state.nav = "ask";
    }
    render();
    if (id === "finance") loadFinance();
  }

  function setNav(key) {
    state.nav = key;
    closeMobileDrawers();
    if (key === "rm") {
      applyPurposeSources("staffing");
      save("odl.purpose", "staffing");
      loadRmPeople();
    }
    render();
  }

  function setMobileDrawer(which) {
    const root = document.getElementById("appRoot");
    const backdrop = document.getElementById("drawerBackdrop");
    const navBtn = document.getElementById("btnMobileNav");
    const srcBtn = document.getElementById("btnMobileSources");
    let next = which || null;
    if (which === "sources") {
      if (state.mobileDrawer === "nav") {
        next = null;
      } else {
        state.sourcesOpen = true;
        save("odl.sourcesOpen", true);
        const panel = document.getElementById("sourcesPanel");
        if (panel) panel.open = true;
        next = "nav";
      }
    } else {
      next = state.mobileDrawer === which ? null : which || null;
    }
    state.mobileDrawer = next;
    if (root) {
      root.classList.toggle("drawer-nav-open", next === "nav");
      root.classList.remove("drawer-sources-open");
    }
    if (backdrop) {
      backdrop.hidden = !next;
      backdrop.setAttribute("aria-hidden", next ? "false" : "true");
    }
    document.body.style.overflow = next ? "hidden" : "";
    if (navBtn) navBtn.setAttribute("aria-expanded", next === "nav" ? "true" : "false");
    if (srcBtn) srcBtn.setAttribute("aria-expanded", next === "nav" && state.sourcesOpen ? "true" : "false");
    if (next === "nav" && which === "sources") {
      requestAnimationFrame(() => {
        const panel = document.getElementById("sourcesPanel");
        if (panel) panel.scrollIntoView({ block: "nearest" });
      });
    }
  }

  function closeMobileDrawers() {
    if (!state.mobileDrawer) return;
    setMobileDrawer(null);
  }

  function resetAsk() {
    closeMobileDrawers();
    state.phase = "idle";
    state.draft = "";
    state.traceOpen = false;
    state.nav = "ask";
    state.project = null;
    state.projectNumber = "";
    state.projectError = "";
    state.thread = [];
    render();
    const el = document.getElementById("draft");
    if (el) el.value = "";
  }

  async function run(_key, text) {
    const question = (text || state.draft || "").trim();
    if (!question) return;
    closeMobileDrawers();
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
      const prior = (state.thread || []).slice(-3);
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          sources: enabledList().map((s) => s.id),
          projectNumber: state.projectNumber || "",
          prior
        })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Ask failed (${res.status})`);
      }
      if (!body.answer) throw new Error("API returned no answer");
      state.answer = body.answer;
      state.phase = "answered";
      state.thread = [
        ...prior,
        {
          question,
          summary: body.answer.summary || "",
          tableTitle: body.answer.tableTitle || "",
          cols: body.answer.cols || [],
          rows: (body.answer.rows || []).slice(0, 12),
          needs: body.answer.needs || [],
          rmIntent: body.answer.rmIntent || null
        }
      ].slice(-4);
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
      btn.onclick = () => {
        setNav(btn.dataset.nav);
        closeMobileDrawers();
      };
    });
  }

  function referencedIds() {
    if (state.phase === "answered" && state.answer && Array.isArray(state.answer.needs)) {
      return state.answer.needs.filter((id) => {
        const s = sourceById(id);
        return s && s.loaded;
      });
    }
    if (state.phase === "project" && state.project) {
      const ids = [];
      if (state.project.jobs && state.project.jobs.length) ids.push("netsuite");
      if ((state.project.studies && state.project.studies.length) || (state.project.sites && state.project.sites.length)) {
        ids.push("ora");
      }
      return ids;
    }
    return enabledList().map((s) => s.id);
  }

  function sourceStatus(s) {
    if (!s.loaded) return { key: "locked", label: "Not loaded" };
    const refs = referencedIds();
    const answering = state.phase === "answered" || state.phase === "project";
    if (answering) {
      if (refs.includes(s.id)) return { key: "ref", label: "Referenced" };
      return { key: "dim", label: "Not used" };
    }
    if (state.enabled[s.id]) return { key: "scope", label: "In scope" };
    return { key: "dim", label: "Out of scope" };
  }

  function renderSources() {
    const refs = referencedIds();
    const answering = state.phase === "answered" || state.phase === "project";
    const asOf = state.briefing && state.briefing.asOfLabel ? state.briefing.asOfLabel : "as-of pending";
    const refNames = refs.map((id) => sourceById(id)).filter(Boolean).map((s) => s.name);

    document.getElementById("enabledSummary").textContent = answering
      ? refNames.length
        ? `This answer used ${refNames.join(" · ")}`
        : "No Cosmos sources cited for this answer."
      : enabledList().length
        ? `${(purposeOf(state.purpose) && purposeOf(state.purpose).label) || "Ask"} can pull from ${enabledList().map((s) => s.name).join(" · ")}`
        : "Pick a purpose above to set which loaded sources are in scope.";

    document.getElementById("enabledCount").textContent = answering
      ? `${refs.length} source${refs.length === 1 ? "" : "s"} referenced`
      : `${enabledList().length} of ${loadedSources().length} loaded sources in scope`;

    document.getElementById("scopeLine").textContent = answering
      ? `${refs.length} referenced · ${asOf}`
      : `${enabledList().length} in scope · ${asOf}`;

    document.getElementById("sourceList").innerHTML = SOURCES.map((s) => {
      const st = sourceStatus(s);
      return `<div class="source-card ${st.key}" data-src="${s.id}">
        <span class="source-dot" style="background:${DOT[s.id] || "var(--ora-gray-400)"}"></span>
        <span style="min-width:0;flex:1">
          <span class="source-top">
            <span class="source-name">${s.name}</span>
            <span class="source-status">${st.label}</span>
          </span>
          <span class="source-cat">${s.cat}</span>
          <span class="source-scope">${s.scope}</span>
        </span>
      </div>`;
    }).join("");

    const panel = document.getElementById("sourcesPanel");
    if (panel) {
      if (panel.open !== !!state.sourcesOpen) panel.open = !!state.sourcesOpen;
      panel.ontoggle = () => {
        if (state.sourcesOpen === panel.open) return;
        state.sourcesOpen = panel.open;
        save("odl.sourcesOpen", panel.open);
      };
    }
  }

  function suggestButtons(questions) {
    return (
      questions
        .map(
          (q) => `<button type="button" class="suggest">
            <span class="suggest-icon">${ICONS[q.icon] || ICONS.chart}</span>
            <span><span class="suggest-text">${q.text}</span><span class="suggest-needs">${q.needs}</span></span>
          </button>`
        )
        .join("")
    );
  }

  function bindSuggests(panel, questions) {
    panel.querySelectorAll(".suggest").forEach((btn, i) => {
      btn.onclick = () => run("live", questions[i].text);
    });
  }

  function renderPurpose() {
    const root = document.getElementById("purpose");
    if (!root || typeof PURPOSES === "undefined") return;
    root.innerHTML = PURPOSES.map(
      (p) =>
        `<button type="button" class="purpose-btn${state.purpose === p.id ? " active" : ""}" data-purpose="${p.id}" title="${p.hint}">${p.label}</button>`
    ).join("");
    root.querySelectorAll("[data-purpose]").forEach((btn) => {
      btn.onclick = () => setPurpose(btn.dataset.purpose);
    });
  }

  function renderRmIdle(panel) {
    const r = state.rm;
    if (!r) {
      panel.innerHTML = `<div class="briefing"><div class="suggest-head">RM</div><div class="briefing-note">Loading InsightsRM briefing…</div></div>`;
      return;
    }
    const kpis = r.loaded
      ? `<div class="kpi-row">
          <div class="kpi"><div class="kpi-value">${r.overCount}</div><div class="kpi-label">Over-allocated</div></div>
          <div class="kpi"><div class="kpi-value">${r.underCount != null ? r.underCount : "—"}</div><div class="kpi-label">Under-utilized</div></div>
          <div class="kpi"><div class="kpi-value">${r.shortRoles}</div><div class="kpi-label">Roles short</div></div>
          <div class="kpi"><div class="kpi-value">${r.studies}</div><div class="kpi-label">Studies</div></div>
          <div class="kpi"><div class="kpi-value">${r.employees}</div><div class="kpi-label">Employees</div></div>
        </div>`
      : `<div class="briefing-note">${escapeHtml(r.note || "No RM snapshot in Cosmos yet.")}</div>`;
    const top =
      r.loaded && r.topOver && r.topOver.length
        ? `<div class="briefing-note" style="margin-top:6px">Top: ${r.topOver
            .map((x) => `${escapeHtml(x.name || "—")} (+${Number(x.overFte || 0).toFixed(2)} FTE)`)
            .join(" · ")}</div>`
        : "";
    const q = typeof STAFFING_QUESTIONS !== "undefined" ? STAFFING_QUESTIONS : EXAMPLE_QUESTIONS;
    panel.innerHTML =
      `<div class="briefing">
        <div class="suggest-head">RM briefing</div>
        ${kpis}
        <div class="briefing-note">${escapeHtml(r.asOfLabel || "")}${r.lastBlob ? ` · ${escapeHtml(String(r.lastBlob).split("/").pop())}` : ""}. Joins follow Model_Relationships (studyKey, employeeKey, roleId).</div>
        ${top}
      </div>
      <div class="suggest-head">Suggested prompts</div>` +
      suggestButtons(q);
    bindSuggests(panel, q);
  }

  function renderFinanceIdle(panel) {
    const f = state.finance;
    if (!f) {
      panel.innerHTML = `<div class="briefing"><div class="suggest-head">Finance</div><div class="briefing-note">Loading NetSuite profitability…</div></div>`;
      return;
    }
    const kpis = f.loaded
      ? `<div class="kpi-row">
          <div class="kpi"><div class="kpi-value">${f.projects}</div><div class="kpi-label">Jobs in snapshot</div></div>
          <div class="kpi"><div class="kpi-value">${f.underGm}</div><div class="kpi-label">Under budgeted GM</div></div>
          <div class="kpi"><div class="kpi-value">${f.missingGm}</div><div class="kpi-label">GM missing</div></div>
          <div class="kpi"><div class="kpi-value">${f.linked}</div><div class="kpi-label">Linked to a study</div></div>
          <div class="kpi"><div class="kpi-value">${f.unlinked}</div><div class="kpi-label">No study match</div></div>
        </div>`
      : `<div class="briefing-note">${escapeHtml(f.note || "No NetSuite snapshot in Cosmos yet.")}</div>`;
    const q = typeof FINANCE_QUESTIONS !== "undefined" ? FINANCE_QUESTIONS : EXAMPLE_QUESTIONS;
    const needle = (state.projectFilter || "").trim().toLowerCase();
    const rows = (f.rows || []).filter((r) => {
      if (!needle) return true;
      return [r.project_number, r.project_name, r.customer_name, r.service_line, r.project_manager]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
    const list = f.loaded
      ? `<div class="project-toolbar">
          <input class="project-filter" id="projectFilter" type="search" placeholder="Filter by number, name, customer, PM…" value="${escapeHtml(state.projectFilter)}" />
          <span class="project-count">${rows.length} shown</span>
        </div>` +
        (rows.length
          ? rows
              .map((r) => {
                const gm = r.gm_pct_variance;
                return `<button type="button" class="project-card" data-pn="${escapeHtml(r.project_number)}">
                  <span class="project-num">${escapeHtml(r.project_number)}</span>
                  <span>
                    <span class="project-name">${escapeHtml(r.project_name || "—")}</span>
                    <div class="project-sub">${escapeHtml([r.customer_name, r.service_line, r.project_status].filter(Boolean).join(" · ") || "—")}</div>
                    <span class="link-badge${r.linkedStudyCount ? "" : " off"}">${
                      r.linkedStudyCount
                        ? `${r.linkedStudyCount} study match`
                        : "no study match"
                    }</span>
                  </span>
                  <span class="project-gm ${gmClass(gm)}">${fmtPct(gm)}</span>
                </button>`;
              })
              .join("")
          : `<p class="empty">No projects match that filter.</p>`)
      : "";

    panel.innerHTML =
      `<div class="briefing">
        <div class="suggest-head">Finance briefing</div>
        ${kpis}
        <div class="briefing-note">${escapeHtml(f.asOfLabel || "")}${f.note ? ` · ${escapeHtml(f.note)}` : ""}</div>
      </div>
      <div class="suggest-head">Ask these, or click a project</div>` +
      suggestButtons(q) +
      `<div class="suggest-head" style="margin-top:8px">Projects</div>` +
      list;

    bindSuggests(panel, q);
    const filter = document.getElementById("projectFilter");
    if (filter) {
      filter.oninput = (e) => {
        state.projectFilter = e.target.value;
        const pos = e.target.selectionStart;
        renderFinanceIdle(panel);
        const again = document.getElementById("projectFilter");
        if (again) {
          again.focus();
          try {
            again.setSelectionRange(pos, pos);
          } catch (_) {}
        }
      };
    }
    panel.querySelectorAll("[data-pn]").forEach((btn) => {
      btn.onclick = () => openProject(btn.dataset.pn);
    });
  }

  function renderIdle() {
    const panel = document.getElementById("idlePanel");
    panel.classList.toggle("hidden", state.phase !== "idle");
    if (state.phase !== "idle") return;

    if (state.purpose === "finance") {
      renderFinanceIdle(panel);
      return;
    }

    if (state.purpose === "bd") {
      const q = typeof BD_QUESTIONS !== "undefined" ? BD_QUESTIONS : EXAMPLE_QUESTIONS;
      panel.innerHTML =
        `<div class="briefing">
          <div class="suggest-head">Business development</div>
          <div class="briefing-note">Registry and sponsor questions. Salesforce is a crosswalk, not pipeline revenue.</div>
        </div>
        <div class="suggest-head">Suggested prompts</div>` + suggestButtons(q);
      bindSuggests(panel, q);
      return;
    }

    if (state.purpose === "staffing") {
      renderRmIdle(panel);
      return;
    }

    const b = state.briefing;
    const kpis = b
      ? `<div class="briefing">
          <div class="suggest-head">ClinOps briefing</div>
          <div class="kpi-row">
            <div class="kpi"><div class="kpi-value">${b.studies}</div><div class="kpi-label">Studies in rollup</div></div>
            <div class="kpi"><div class="kpi-value">${b.withEnrolled}</div><div class="kpi-label">Have enrolled</div></div>
            <div class="kpi"><div class="kpi-value">${b.missingEnrolled}</div><div class="kpi-label">Enrolled missing</div></div>
            <div class="kpi"><div class="kpi-value">${b.dryEye}</div><div class="kpi-label">Dry eye</div></div>
            <div class="kpi"><div class="kpi-value">${b.glaucoma}</div><div class="kpi-label">Glaucoma</div></div>
          </div>
          <div class="briefing-note">${escapeHtml(b.asOfLabel)}${b.topStudy ? ` · top enrolled ${escapeHtml(b.topStudy.study)} (${b.topStudy.enrolled})` : ""}. Missing enrolled is not zero.</div>
        </div>`
      : `<div class="briefing"><div class="suggest-head">ClinOps briefing</div><div class="briefing-note">Loading Cosmos rollup…</div></div>`;
    panel.innerHTML =
      kpis +
      `<div class="suggest-head">Suggested prompts</div>` +
      suggestButtons(EXAMPLE_QUESTIONS);
    bindSuggests(panel, EXAMPLE_QUESTIONS);
  }

  function renderThinking() {
    const panel = document.getElementById("thinkingPanel");
    panel.classList.toggle("hidden", state.phase !== "thinking");
    panel.innerHTML = `<div class="thinking">
      <div class="thinking-row"><span class="lens-mark" aria-hidden="true"></span><span>Reading Cosmos · asking Foundry</span></div>
      <div class="skel" style="width:72%"></div>
      <div class="skel" style="width:94%"></div>
      <div class="skel" style="width:48%"></div>
    </div>`;
  }

  function renderAnswer() {
    const panel = document.getElementById("answerPanel");
    if (state.phase === "project") {
      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      }
      return;
    }
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
    const missingNames = missing.map((id) => {
      const s = sourceById(id);
      return s ? s.name : id;
    });
    const confKey = missing.length ? "partial" : a.confidence;
    const conf = CONF[confKey];

    const missingBanner = a.missingNote
      ? `<div class="gap gap-info"><div style="flex:1">
          <div class="gap-title">Missing is not zero</div>
          <div class="gap-body">${escapeHtml(a.missingNote)}</div>
        </div></div>`
      : "";
    const gap = a.foundryError
      ? `<div class="gap"><div style="flex:1">
          <div class="gap-title">Foundry did not answer</div>
          <div class="gap-body">${escapeHtml(a.foundryError)} Numbers below are still from Cosmos.</div>
        </div></div>`
      : missing.length
        ? `<div class="gap">
          <div style="flex:1">
            <div class="gap-title">${escapeHtml(missingNames.join(" and "))} ${missing.length > 1 ? "are" : "is"} out of scope</div>
            <div class="gap-body">This answer needs ${escapeHtml(missingNames.join(" and "))}, which the current purpose leaves greyed. Switch purpose above and ask again — those sources stay dim until they are referenced.</div>
          </div>
        </div>`
        : "";

    const bars = (a.bars || [])
      .map(
        (b) => `<div class="bar-row">
          <span class="bar-label">${b.label}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${b.pct}%;background:${chartBarColor(b.color)}"></span></span>
          <span class="bar-val">${b.value}</span>
        </div>`
      )
      .join("");

    const cols = a.cols
      .map((c) => `<span>${c}</span>`)
      .join("");
    const keys = a.projectKeys || [];
    const rows = a.rows
      .map((r, ri) => {
        const pn = keys[ri] || "";
        return `<div class="table-row${pn ? " clickable" : ""}"${pn ? ` data-pn="${escapeHtml(pn)}"` : ""} style="grid-template-columns:${a.grid}">${r
          .map((cell, i) => `<span class="${i === 0 ? "cell-strong" : i < 3 ? "cell-mono" : ""}">${cell}</span>`)
          .join("")}</div>`;
      })
      .join("");

    const cites = (a.needs || [])
      .map((id) => sourceById(id))
      .filter(Boolean)
      .map(
        (s) => `<span class="cite"><span class="cite-dot" style="background:${DOT[s.id]}"></span><span class="cite-name">${s.name}</span><span class="cite-detail">${DETAIL[s.id]}</span></span>`
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
      ${missingBanner}
      <div class="answer">
        <div class="answer-head">
          <span class="conf" style="background:${conf.bg};color:${conf.color}"><span class="conf-dot" style="background:${conf.color}"></span>${conf.label}</span>
          ${
            a.viewer && a.viewer.role
              ? `<span class="viewer-chip">Framed for ${escapeHtml(a.viewer.role)}</span>`
              : ""
          }
          <span class="chart-note">${escapeHtml(a.asOfLabel || a.chartNote)}</span>
        </div>
        <p class="summary">${a.summary}</p>
        <div class="block">
          <span class="block-title">${a.chartTitle}</span>
          ${a.bars && a.bars.length ? `<div class="chart-wrap"><canvas id="odlChart"></canvas></div><div class="bars">${bars}</div>` : `<p class="caveat">No chart — there are no known values to plot. Table still lists rows, including missing enrolled.</p>`}
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

    const tog = document.getElementById("toggleTrace");
    if (tog) tog.onclick = () => {
      state.traceOpen = !state.traceOpen;
      render();
    };
    panel.querySelectorAll(".follow").forEach((btn) => {
      btn.onclick = () => run(guessKey(btn.textContent), btn.textContent);
    });
    panel.querySelectorAll("[data-pn]").forEach((row) => {
      row.onclick = () => openProject(row.dataset.pn);
    });

    drawChart(a);
  }

  function renderProject() {
    const panel = document.getElementById("answerPanel");
    if (state.phase !== "project") return;
    panel.classList.remove("hidden");
    if (state.projectError && !state.project) {
      panel.innerHTML = `<button type="button" class="btn btn-ghost project-back" id="projBack">← All projects</button>
        <div class="gap"><div style="flex:1">
          <div class="gap-title">Could not load project</div>
          <div class="gap-body">${escapeHtml(state.projectError)}</div>
        </div></div>`;
      const back = document.getElementById("projBack");
      if (back) back.onclick = resetAsk;
      return;
    }
    if (!state.project) {
      panel.innerHTML = `<div class="thinking">
        <div class="thinking-row"><span class="lens-mark" aria-hidden="true"></span><span>Joining NetSuite to ora_veeva_study…</span></div>
        <div class="skel" style="width:72%"></div>
        <div class="skel" style="width:48%"></div>
      </div>`;
      return;
    }

    const p = state.project;
    const job = p.jobs && p.jobs[0];
    const title = job ? job.project_name : p.project_number;
    const jobs = p.jobs || [];
    const studies = p.studies || [];
    const sites = p.sites || [];

    const jobRows = jobs
      .map(
        (r) => `<div class="table-row" style="grid-template-columns:1.4fr 0.8fr 0.7fr 0.7fr 0.7fr 1fr">
          <span class="cell-strong">${escapeHtml(r.project_name || "—")}</span>
          <span class="cell-mono">${escapeHtml(r.service_line || "—")}</span>
          <span class="cell-mono">${fmtPct(r.budgeted_gm_pct)}</span>
          <span class="cell-mono">${fmtPct(r.actual_gm_pct_prior_month)}</span>
          <span class="cell-mono">${fmtPct(r.gm_pct_variance)}</span>
          <span>${escapeHtml(r.change_order_status || "—")}</span>
        </div>`
      )
      .join("");

    const studyRows = studies.length
      ? studies
          .map(
            (s) => `<div class="table-row" style="grid-template-columns:1fr 0.7fr 0.6fr 0.7fr 1fr">
              <span class="cell-strong">${escapeHtml(s.study_number || "—")}</span>
              <span class="cell-mono">${s.total_enrolled == null ? "—" : s.total_enrolled}</span>
              <span class="cell-mono">${s.psm == null ? "—" : s.psm}</span>
              <span>${escapeHtml(s.match || "—")}</span>
              <span>${escapeHtml(s.indication || "—")}</span>
            </div>`
          )
          .join("")
      : `<p class="empty">No ora_veeva_study.study_number matched ${escapeHtml(p.project_number)}.</p>`;

    const siteRows = sites.length
      ? sites
          .map(
            (s) => `<div class="table-row" style="grid-template-columns:1.2fr 0.8fr 0.7fr 0.6fr 0.6fr">
              <span class="cell-strong">${escapeHtml(s.site || "—")}</span>
              <span class="cell-mono">${escapeHtml(s.study_name || "—")}</span>
              <span>${escapeHtml(s.country || "—")}</span>
              <span class="cell-mono">${s.enrolled == null ? "—" : s.enrolled}</span>
              <span class="cell-mono">${s.site_psm == null ? "—" : s.site_psm}</span>
            </div>`
          )
          .join("")
      : "";

    const prompts = [
      `What is GM on ${p.project_number}?`,
      `Enrollment for ${p.project_number}`,
      `Sites for ${p.project_number}`
    ];

    panel.innerHTML = `
      <button type="button" class="btn btn-ghost project-back" id="projBack">← All projects</button>
      <div class="answer">
        <div class="answer-head">
          <span class="conf" style="background:var(--status-info-bg);color:var(--ora-blue-600)"><span class="conf-dot" style="background:var(--ora-blue-600)"></span>${escapeHtml(p.project_number)}</span>
          <span class="chart-note">${escapeHtml(p.asOfLabel || "computed join · no mapping table")}</span>
        </div>
        <p class="summary">${escapeHtml(title || p.project_number)}</p>
        <div class="detail-grid">
          <div class="detail-card"><div class="detail-label">Customer</div><div class="detail-value">${escapeHtml((job && job.customer_name) || "—")}</div></div>
          <div class="detail-card"><div class="detail-label">PM</div><div class="detail-value">${escapeHtml((job && job.project_manager) || "—")}</div></div>
          <div class="detail-card"><div class="detail-label">Status</div><div class="detail-value">${escapeHtml((job && job.project_status) || "—")}</div></div>
          <div class="detail-card"><div class="detail-label">Budget GM</div><div class="detail-value">${fmtPct(job && job.budgeted_gm_pct)}</div></div>
          <div class="detail-card"><div class="detail-label">Actual GM</div><div class="detail-value">${fmtPct(job && job.actual_gm_pct_prior_month)}</div></div>
          <div class="detail-card"><div class="detail-label">Variance</div><div class="detail-value">${fmtPct(job && job.gm_pct_variance)}</div></div>
          <div class="detail-card"><div class="detail-label">EOS GM</div><div class="detail-value">${fmtPct(job && job.projected_eos_gm_pct_prior_month)}</div></div>
          <div class="detail-card"><div class="detail-label">Cost / billable hr</div><div class="detail-value">${fmtMoney(job && job.cost_per_billable_hr_actual)} / ${fmtMoney(job && job.cost_per_billable_hr_budgeted)}</div></div>
        </div>
        <div class="join-note">${escapeHtml((p.join && p.join.note) || "")}</div>
        <div class="block">
          <span class="block-title">NetSuite jobs (${jobs.length})</span>
          <div class="table-wrap">
            <div class="table-head" style="grid-template-columns:1.4fr 0.8fr 0.7fr 0.7fr 0.7fr 1fr"><span>Job</span><span>Service line</span><span>Budget GM</span><span>Actual GM</span><span>Variance</span><span>Change order</span></div>
            ${jobRows || `<p class="empty">No lens_ns_projects row for this number.</p>`}
          </div>
        </div>
        <div class="block">
          <span class="block-title">ora_veeva_study (${studies.length}) · joined on study_number</span>
          <div class="table-wrap">
            ${
              studies.length
                ? `<div class="table-head" style="grid-template-columns:1fr 0.7fr 0.6fr 0.7fr 1fr"><span>Study</span><span>Enrolled</span><span>PSM</span><span>Match</span><span>Indication</span></div>${studyRows}`
                : studyRows
            }
          </div>
        </div>
        ${
          sites.length
            ? `<div class="block">
          <span class="block-title">ora_veeva_site (${sites.length})</span>
          <div class="table-wrap">
            <div class="table-head" style="grid-template-columns:1.2fr 0.8fr 0.7fr 0.6fr 0.6fr"><span>Site</span><span>Study</span><span>Country</span><span>Enrolled</span><span>Site PSM</span></div>
            ${siteRows}
          </div>
        </div>`
            : ""
        }
      </div>
      <div>
        <div class="suggest-head" style="margin-bottom:10px">Ask about this project</div>
        <div class="follows">${prompts.map((t) => `<button type="button" class="follow">${escapeHtml(t)}</button>`).join("")}</div>
      </div>`;

    const back = document.getElementById("projBack");
    if (back) back.onclick = resetAsk;
    panel.querySelectorAll(".follow").forEach((btn) => {
      btn.onclick = () => run("live", btn.textContent);
    });
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
            backgroundColor: a.bars.map((b) => chartBarColor(b.color)),
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
            grid: { color: cssToken("--chart-grid", "#e3e4e6") },
            ticks: { color: cssToken("--text-muted", "#63666b"), font: { family: "Roboto Mono", size: 11 } }
          },
          y: {
            grid: { display: false },
            ticks: { color: cssToken("--chart-tick", "#052c49"), font: { family: "Roboto", size: 12 } }
          }
        }
      }
    });
  }

  function playbooks() {
    if (state.viewer && Array.isArray(state.viewer.playbooks) && state.viewer.playbooks.length) {
      return state.viewer.playbooks;
    }
    return typeof ROLE_PLAYBOOKS !== "undefined" ? ROLE_PLAYBOOKS : [];
  }

  function renderContext() {
    const panel = document.getElementById("viewContext");
    if (!panel) return;
    panel.classList.toggle("hidden", state.nav !== "context");
    if (state.nav !== "context") return;

    if (state.viewerError && !state.viewer) {
      panel.innerHTML = `<div class="answer">
        <p class="summary">Sign in with Entra to save your lens. ${escapeHtml(state.viewerError)}</p>
        <p class="caveat">Role playbooks live in the app. Cosmos only stores which one is yours, plus extras you add.</p>
      </div>`;
      return;
    }

    const v = state.viewer;
    if (!v) {
      panel.innerHTML = `<div class="briefing"><div class="suggest-head">My context</div><div class="briefing-note">Loading Entra preference…</div></div>`;
      return;
    }

    const books = playbooks();
    const extras = v.extras || [];

    const roles = books
      .map((p) => {
        const on = v.roleKey === p.key;
        const then = (p.then || []).join(" → ");
        return `<button type="button" class="role-card${on ? " active" : ""}" data-role="${p.key}">
          <span class="role-label">${escapeHtml(p.label)}</span>
          <span class="role-order">Lead with ${escapeHtml(p.primary || "—")}${then ? ` → ${escapeHtml(then)}` : ""}</span>
          <span class="role-inst">${escapeHtml(p.instruction)}</span>
        </button>`;
      })
      .join("");

    const extraRows = extras.length
      ? extras
          .map(
            (e) => `<div class="extra-row">
              <span>${escapeHtml(e.text)}</span>
              <button type="button" class="btn btn-ghost extra-del" data-xid="${escapeHtml(e.id)}">Remove</button>
            </div>`
          )
          .join("")
      : `<p class="empty">No extras yet. Add a named project, a direct-report team, or a standing note.</p>`;

    const entra = v.entra || {};
    const entraNote = entra.ok
      ? `Entra job title: ${entra.jobTitle || "(blank in Entra)"}${entra.department ? ` · ${entra.department}` : ""}${
          entra.suggestedRoleKey ? ` · maps to ${entra.suggestedRoleKey}` : " · no playbook match — pick one below"
        }`
      : entra.error
        ? `Graph: ${entra.error}`
        : "Graph profile not loaded.";
    const sourceNote =
      v.roleSource === "override"
        ? "Using your override, not the Entra title."
        : v.roleSource === "entra"
          ? "Using Entra job title."
          : v.roleLabel
            ? `Active: ${v.roleLabel}`
            : "No role yet.";

    panel.innerHTML = `<div class="answer">
      <p class="summary">Entra job title is the default playbook. Cosmos extras stay secondary. Warehouse numbers never come from Graph.</p>
      <div class="join-note">${escapeHtml(entraNote)} ${escapeHtml(sourceNote)}${state.savingContext ? " · saving…" : ""}</div>
      ${
        entra.manager || (entra.reports && entra.reports.length)
          ? `<div class="briefing-note" style="margin:8px 0 12px">${
              entra.manager ? `Manager: ${escapeHtml(entra.manager.displayName)}` : ""
            }${
              entra.reports && entra.reports.length
                ? `${entra.manager ? " · " : ""}Reports: ${escapeHtml(entra.reports.map((r) => r.displayName).join(", "))}`
                : ""
            }</div>`
          : ""
      }
      <div class="suggest-head">Position</div>
      <div class="role-grid">${roles}</div>
      ${
        v.roleOverride
          ? `<button type="button" class="btn btn-ghost" id="btnUseEntra" style="margin:8px 0 16px">Use Entra job title</button>`
          : ""
      }
      <div class="block">
        <span class="block-title">Extras (optional)</span>
        ${extraRows}
        <div class="extra-add">
          <input id="extraDraft" class="project-filter" type="text" maxlength="400" placeholder="e.g. I PM 02-123-4567 · reports: Jane, Luis" value="${escapeHtml(state.extraDraft)}" />
          <button type="button" class="btn btn-secondary" id="btnAddExtra">Add</button>
        </div>
      </div>
      <div class="block">
        <span class="block-title">Standing note</span>
        <textarea id="notesDraft" rows="3" class="notes-box" placeholder="Anything Ask should remember about how you work — still secondary to Cosmos facts.">${escapeHtml(v.notes || "")}</textarea>
        <div class="project-toolbar" style="margin-top:10px">
          <button type="button" class="btn btn-secondary" id="btnSaveNotes">Save note</button>
          <button type="button" class="btn btn-ghost" id="btnClearContext">Remove my context</button>
        </div>
      </div>
      <p class="caveat">Ask uses this as VIEWER framing only. Foundry cannot invent employees or GM from a note.</p>
    </div>`;

    panel.querySelectorAll("[data-role]").forEach((btn) => {
      btn.onclick = () => saveContext({ roleKey: btn.dataset.role });
    });
    const useEntra = document.getElementById("btnUseEntra");
    if (useEntra) useEntra.onclick = () => saveContext({ useEntra: true });
    const extraIn = document.getElementById("extraDraft");
    if (extraIn) {
      extraIn.oninput = (e) => {
        state.extraDraft = e.target.value;
      };
      extraIn.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addExtra();
        }
      };
    }
    const addBtn = document.getElementById("btnAddExtra");
    if (addBtn) addBtn.onclick = addExtra;
    panel.querySelectorAll(".extra-del").forEach((btn) => {
      btn.onclick = () => {
        const next = extras.filter((e) => e.id !== btn.dataset.xid);
        saveContext({ extras: next });
      };
    });
    const notesEl = document.getElementById("notesDraft");
    if (notesEl) {
      notesEl.oninput = (e) => {
        state.notesDraft = e.target.value;
      };
    }
    const saveNotes = document.getElementById("btnSaveNotes");
    if (saveNotes) {
      saveNotes.onclick = () => {
        const el = document.getElementById("notesDraft");
        saveContext({ notes: el ? el.value : "" });
      };
    }
    const clearBtn = document.getElementById("btnClearContext");
    if (clearBtn) clearBtn.onclick = clearContext;
  }

  async function saveContext(patch) {
    state.savingContext = true;
    renderContext();
    try {
      const payload = {
        notes: patch.notes != null ? patch.notes : (state.viewer && state.viewer.notes) || "",
        extras: patch.extras != null ? patch.extras : (state.viewer && state.viewer.extras) || []
      };
      if (patch.roleKey != null) payload.roleKey = patch.roleKey;
      if (patch.useEntra) payload.useEntra = true;
      const res = await fetch("/api/me/context", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
      state.viewer = body.context;
      state.viewerError = "";
      state.extraDraft = "";
      state.notesDraft = (body.context && body.context.notes) || "";
    } catch (err) {
      state.viewerError = String(err.message || err);
    }
    state.savingContext = false;
    render();
  }

  function addExtra() {
    const text = String(state.extraDraft || "").trim();
    if (!text) return;
    const extras = [...((state.viewer && state.viewer.extras) || [])];
    extras.push({ id: `x${Date.now()}`, text });
    state.extraDraft = "";
    saveContext({ extras });
  }

  async function clearContext() {
    if (!window.confirm("Remove your saved role and extras from Cosmos?")) return;
    state.savingContext = true;
    renderContext();
    try {
      const res = await fetch("/api/me/context", { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Delete failed (${res.status})`);
      state.viewer = body.context;
      state.notesDraft = "";
      state.extraDraft = "";
      state.viewerError = "";
    } catch (err) {
      state.viewerError = String(err.message || err);
    }
    state.savingContext = false;
    render();
  }

  async function loadViewer() {
    try {
      const res = await fetch("/api/me/context");
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        state.viewer = null;
        state.viewerError = body.error || "Sign in with Entra.";
        return;
      }
      if (!res.ok) throw new Error(body.error || `Context failed (${res.status})`);
      state.viewer = body.context;
      state.notesDraft = (body.context && body.context.notes) || "";
      state.viewerError = "";
    } catch (err) {
      state.viewer = null;
      state.viewerError = String(err.message || err);
    }
    if (state.nav === "context") render();
  }

  function ymdLocal(d) {
    const dt = d instanceof Date ? d : new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function addDaysYmd(ymd, n) {
    const [y, m, d] = String(ymd)
      .split("-")
      .map((x) => Number(x));
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return ymdLocal(dt);
  }

  function lineOverlaps(line, from, to) {
    if (!from && !to) return true;
    const start = line.beginDate || "0000-01-01";
    const stop = line.endDate || "9999-12-31";
    if (from && stop < from) return false;
    if (to && start > to) return false;
    return true;
  }

  function addMonthsYm(ym, n) {
    const [y, m] = String(ym).split("-").map(Number);
    const dt = new Date(y, m - 1 + n, 1);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthEndYmd(ym) {
    const [y, m] = String(ym).split("-").map(Number);
    const last = new Date(y, m, 0).getDate();
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  }

  function monthLabel(ym) {
    const [y, m] = String(ym).split("-").map(Number);
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${names[m - 1] || ym} ${String(y).slice(2)}`;
  }

  function monthsInView(from, to, today) {
    let start = String(from || "").slice(0, 7);
    let end = String(to || "").slice(0, 7);
    if (!start && !end) {
      start = String(today).slice(0, 7);
      end = addMonthsYm(start, 11);
    } else if (start && !end) {
      end = addMonthsYm(start, 11);
    } else if (!start && end) {
      start = addMonthsYm(end, -11);
    }
    if (start > end) {
      const swap = start;
      start = end;
      end = swap;
    }
    const out = [];
    let cur = start;
    while (cur <= end && out.length < 24) {
      out.push(cur);
      cur = addMonthsYm(cur, 1);
    }
    return out;
  }

  function lineCoversMonth(line, ym) {
    return lineOverlaps(line, `${ym}-01`, monthEndYmd(ym));
  }

  function fmtFte(n) {
    if (n == null || !Number.isFinite(n) || n <= 0) return "";
    if (n >= 9.95) return n.toFixed(0);
    const t = Math.round(n * 10) / 10;
    if (t === 0) return "<0.1";
    return t.toFixed(1);
  }

  function fmtSpan(begin, end) {
    if (begin && end) return `${begin} → ${end}`;
    return begin || end || "";
  }

  function ymdToDays(ymd) {
    const [y, m, d] = String(ymd || "").split("-").map(Number);
    if (!y || !m || !d) return null;
    return Date.UTC(y, m - 1, d) / 86400000;
  }

  function spanFromLines(lines) {
    const begins = (lines || []).map((l) => l.beginDate).filter(Boolean).sort();
    const ends = (lines || []).map((l) => l.endDate).filter(Boolean).sort();
    return { begin: begins[0] || null, end: ends.length ? ends[ends.length - 1] : null };
  }

  function studyStaffEntries(study) {
    if (Array.isArray(study.staff) && study.staff.length) {
      return study.staff.map((p) => ({ person: p }));
    }
    const out = [];
    for (const role of study.roles || []) {
      if (role.person) out.push({ person: role.person, role });
      for (const p of role.staff || []) out.push({ person: p, role });
    }
    return out;
  }

  function collectStudyLines(study) {
    return studyStaffEntries(study).flatMap((e) => e.person.lines || []);
  }

  function activitiesForStudy(study) {
    const byAct = new Map();
    for (const { person } of studyStaffEntries(study)) {
      for (const line of person.lines || []) {
        const act = line.activity || "—";
        if (!byAct.has(act)) byAct.set(act, { activity: act, lines: [], people: new Map() });
        const node = byAct.get(act);
        node.lines.push(line);
        if (person.id) node.people.set(person.id, person);
      }
    }
    return sortActivities([...byAct.keys()]).map((key) => {
      const node = byAct.get(key);
      const span = spanFromLines(node.lines);
      return {
        activity: key,
        begin: span.begin,
        end: span.end,
        staffCount: node.people.size,
        people: [...node.people.values()],
        lines: node.lines
      };
    });
  }

  function peopleInMonth(staff, ym) {
    const byId = new Map();
    for (const p of staff || []) {
      const lines = (p.lines || []).filter((l) => lineCoversMonth(l, ym));
      if (!lines.length) continue;
      const fte = Math.max(...lines.map((l) => Number(l.valueFte) || 0));
      const id = p.id || p.fullName;
      const cur = byId.get(id);
      if (!cur) byId.set(id, { person: p, fte });
      else cur.fte = Math.max(cur.fte, fte);
    }
    return [...byId.values()].sort((a, b) =>
      String(a.person.fullName || "").localeCompare(String(b.person.fullName || ""))
    );
  }

  function studyOverlapsMonths(study, months) {
    if (!months.length) return false;
    const from = `${months[0]}-01`;
    const to = monthEndYmd(months[months.length - 1]);
    return collectStudyLines(study).some((l) => lineOverlaps(l, from, to));
  }

  function ganttBarHtml(begin, end, axisBegin, axisEnd) {
    const a0 = ymdToDays(axisBegin);
    const a1 = ymdToDays(axisEnd);
    const b0 = ymdToDays(begin);
    const b1 = ymdToDays(end);
    if (a0 == null || a1 == null || b0 == null || b1 == null || a1 <= a0) {
      return `<span class="rm-gantt-track"></span>`;
    }
    const left = Math.max(0, Math.min(100, ((b0 - a0) / (a1 - a0)) * 100));
    const right = Math.max(0, Math.min(100, ((b1 - a0) / (a1 - a0)) * 100));
    const w = Math.max(2, right - left);
    return `<span class="rm-gantt-track"><span class="rm-gantt-bar" style="left:${left}%;width:${w}%"></span></span>`;
  }

  function rmActivityGantt(study) {
    const lines = collectStudyLines(study);
    const span = spanFromLines(lines);
    const acts = activitiesForStudy(study);
    if (!span.begin || !span.end || !acts.length) return "";
    const rows = acts
      .map((act) => {
        const names = act.people.map((p) => p.fullName).filter(Boolean).join(", ");
        return `<div class="rm-gantt-row" title="${escapeHtml(names)}">
          <span class="rm-gantt-act">${escapeHtml(act.activity)}</span>
          ${ganttBarHtml(act.begin, act.end, span.begin, span.end)}
          <span class="rm-gantt-dates">${escapeHtml(fmtSpan(act.begin, act.end))}</span>
          <span class="rm-gantt-n">${act.staffCount} staff</span>
        </div>`;
      })
      .join("");
    return `<div class="rm-gantt">
      <div class="rm-gantt-head">
        <span>Activity</span>
        <span class="rm-gantt-axis">Assigned ${escapeHtml(fmtSpan(span.begin, span.end))}</span>
        <span>Window</span>
        <span></span>
      </div>
      ${rows}
    </div>`;
  }

  function studyMetaHtml(study, extra) {
    const span = spanFromLines(collectStudyLines(study));
    const dates = fmtSpan(span.begin, span.end);
    return [extra, dates].filter(Boolean).join(" · ");
  }

  function rmCalCell(fte, title) {
    if (!fte || fte <= 0) return `<td class="rm-cal-empty"></td>`;
    const heat = Math.min(1, fte / 4);
    return `<td class="rm-cal-cell" style="--rm-heat:${heat}" title="${escapeHtml(title || "")}"><span>${escapeHtml(fmtFte(fte))}</span></td>`;
  }

  function rmCalNameCell(id, open, title, meta) {
    return `<th class="rm-cal-name" scope="row"><button type="button" class="rm-cal-toggle" data-cal-open="${escapeHtml(id)}" aria-expanded="${open ? "true" : "false"}"><span class="rm-cal-caret" aria-hidden="true">${open ? "▾" : "▸"}</span><span class="rm-cal-label">${escapeHtml(title)}</span><span class="rm-cal-meta">${escapeHtml(meta)}</span></button></th>`;
  }

  function rmCalSubName(title, meta, cls) {
    return `<th class="rm-cal-name rm-cal-indent${cls ? " " + cls : ""}" scope="row"><span class="rm-cal-label">${escapeHtml(title)}</span><span class="rm-cal-meta">${escapeHtml(meta)}</span></th>`;
  }

  function renderRmCalendar(layer, studies, months, opts) {
    if (!months.length) return `<p class="empty">Pick a date range to show months.</p>`;
    const monthHeads = months.map((ym) => `<th class="rm-cal-mon">${escapeHtml(monthLabel(ym))}</th>`).join("");
    const auto = opts.autoOpen;
    let body = "";

    if (layer === "employee") {
      const people = layerByEmployee(studies).filter((row) =>
        row.studies.some((s) => studyOverlapsMonths(s, months))
      );
      body = people
        .map((row) => {
          const id = `cal-emp:${row.person.id}`;
          const open = !!state.rmOpen[id] || auto || people.length === 1;
          const staffAll = row.studies.flatMap((s) => studyStaffEntries(s).map((e) => e.person));
          const cells = months
            .map((ym) => {
              let fte = 0;
              let n = 0;
              for (const study of row.studies) {
                const load = peopleInMonth(
                  studyStaffEntries(study).map((e) => e.person),
                  ym
                );
                const studyFte = load.reduce((sum, x) => sum + x.fte, 0);
                if (studyFte > 0) {
                  fte += studyFte;
                  n += 1;
                }
              }
              return rmCalCell(fte, fte ? `${row.person.fullName} · ${n} stud${n === 1 ? "y" : "ies"} · ${fmtFte(fte)} FTE` : "");
            })
            .join("");
          const span = spanFromLines(staffAll.flatMap((p) => p.lines || []));
          const active = months.filter((ym) =>
            row.studies.some((s) => peopleInMonth(studyStaffEntries(s).map((e) => e.person), ym).length)
          ).length;
          let html = `<tr class="rm-cal-study">${rmCalNameCell(id, open, row.person.fullName, [row.person.jobTitle || "—", fmtSpan(span.begin, span.end), `${active} mo`].filter(Boolean).join(" · "))}${cells}</tr>`;
          if (open) {
            for (const study of row.studies) {
              const staff = studyStaffEntries(study).map((e) => e.person);
              const scells = months
                .map((ym) => {
                  const load = peopleInMonth(staff, ym);
                  const fte = load.reduce((n, x) => n + x.fte, 0);
                  return rmCalCell(fte, fte ? `${study.studyKey} · ${fmtFte(fte)} FTE` : "");
                })
                .join("");
              html += `<tr class="rm-cal-sub">${rmCalSubName(study.studyKey, studyMetaHtml(study, study.studyName || ""))}${scells}</tr>`;
            }
          }
          return html;
        })
        .join("");
    } else if (layer === "role") {
      const roles = layerByRole(studies).filter((role) =>
        role.studies.some((s) => studyOverlapsMonths(s, months))
      );
      body = roles
        .map((role) => {
          const id = `cal-role:${role.roleCode}`;
          const open = !!state.rmOpen[id] || !!opts.roleSel || auto || roles.length === 1;
          const cells = months
            .map((ym) => {
              const load = peopleInMonth(role.studies.flatMap((s) => s.staff || []), ym);
              const fte = load.reduce((n, x) => n + x.fte, 0);
              return rmCalCell(fte, fte ? `${role.roleCode} · ${load.length} staff · ${fmtFte(fte)} FTE` : "");
            })
            .join("");
          let html = `<tr class="rm-cal-study">${rmCalNameCell(id, open, role.roleCode, `${role.roleGroup || "Role"} · ${role.studyCount} studies`)}${cells}</tr>`;
          if (open) {
            for (const study of role.studies) {
              if (!studyOverlapsMonths(study, months)) continue;
              const scells = months
                .map((ym) => {
                  const load = peopleInMonth(study.staff, ym);
                  const fte = load.reduce((n, x) => n + x.fte, 0);
                  return rmCalCell(fte, fte ? `${study.studyKey} · ${load.length} staff · ${fmtFte(fte)} FTE` : "");
                })
                .join("");
              html += `<tr class="rm-cal-sub">${rmCalSubName(study.studyKey, studyMetaHtml(study, `${study.staff.length} staff`))}${scells}</tr>`;
            }
          }
          return html;
        })
        .join("");
    } else {
      const shown = studies.filter((s) => studyOverlapsMonths(s, months));
      body = shown
        .map((study) => {
          const id = `cal:${study.studyKey}`;
          const open = !!state.rmOpen[id] || !!opts.studySel || auto || shown.length === 1;
          const staff = studyStaffEntries(study).map((e) => e.person);
          const perMonth = months.map((ym) => peopleInMonth(staff, ym));
          const cells = perMonth
            .map((load) => {
              const fte = load.reduce((n, x) => n + x.fte, 0);
              const names = load.map((x) => x.person.fullName).join(", ");
              return rmCalCell(fte, fte ? `${load.length} staff · ${fmtFte(fte)} FTE${names ? " · " + names : ""}` : "");
            })
            .join("");
          const span = spanFromLines(collectStudyLines(study));
          const active = perMonth.filter((p) => p.length).length;
          let html = `<tr class="rm-cal-study">${rmCalNameCell(id, open, study.studyKey, [study.studyName || "", fmtSpan(span.begin, span.end), `${active} mo`].filter(Boolean).join(" · "))}${cells}</tr>`;
          if (open) {
            for (const act of activitiesForStudy(study)) {
              const actStaff = staff.map((p) => ({
                ...p,
                lines: (p.lines || []).filter((l) => String(l.activity || "") === act.activity)
              }));
              const acells = months
                .map((ym) => {
                  const load = peopleInMonth(actStaff, ym);
                  const fte = load.reduce((n, x) => n + x.fte, 0);
                  const names = load.map((x) => x.person.fullName).join(", ");
                  return rmCalCell(fte, fte ? `${act.activity} · ${load.length} staff · ${fmtFte(fte)} FTE${names ? " · " + names : ""}` : "");
                })
                .join("");
              html += `<tr class="rm-cal-sub rm-cal-act">${rmCalSubName(act.activity, `${fmtSpan(act.begin, act.end)} · ${act.staffCount} staff`, "rm-cal-act-name")}${acells}</tr>`;
            }
            const people = [...new Map(staff.map((p) => [p.id || p.fullName, p])).values()].sort((a, b) =>
              String(a.fullName || "").localeCompare(String(b.fullName || ""))
            );
            for (const p of people) {
              const pcells = months
                .map((ym) => {
                  const load = peopleInMonth([p], ym);
                  const fte = load.reduce((n, x) => n + x.fte, 0);
                  return rmCalCell(fte, fte ? `${p.fullName} · ${fmtFte(fte)} FTE` : "");
                })
                .join("");
              html += `<tr class="rm-cal-sub">${rmCalSubName(p.fullName, p.jobTitle || "")}${pcells}</tr>`;
            }
          }
          return html;
        })
        .join("");
    }

    return `<div class="rm-cal-wrap"><table class="rm-cal"><thead><tr><th class="rm-cal-name">Study / activity</th>${monthHeads}</tr></thead><tbody>${
      body || `<tr><td class="rm-cal-empty-msg" colspan="${months.length + 1}">No assignments overlap this month window.</td></tr>`
    }</tbody></table></div>`;
  }

  function restoreRmField(id, selStart) {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus();
    if (typeof selStart === "number" && el.setSelectionRange) {
      try {
        el.setSelectionRange(selStart, selStart);
      } catch (_) {}
    }
  }

  function uniqueSorted(vals) {
    return [...new Set((vals || []).filter((v) => v != null && String(v).trim() !== "" && String(v).trim() !== "—"))]
      .map(String)
      .sort((a, b) => a.localeCompare(b));
  }

  function sortActivities(list) {
    return [...list].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  function utilBarHtml(u) {
    if (!u) return "";
    const cap = Number(u.timeAllocation);
    const assigned = u.assignedFte == null ? null : Number(u.assignedFte);
    if (!Number.isFinite(cap) || cap <= 0 || assigned == null || !Number.isFinite(assigned)) return "";
    const pct = Math.round((assigned / cap) * 1000) / 10;
    const w = Math.min(100, Math.max(0, pct));
    const tone = assigned - cap > 0.001 ? "over" : cap - assigned > 0.05 ? "spare" : "ok";
    return `<span class="rm-util"><span class="dedicate-track rm-util-track"><span class="dedicate-fill ${tone}" style="width:${w}%"></span></span><span class="rm-util-label">${pct.toFixed(0)}% · ${assigned.toFixed(2)}/${cap.toFixed(2)} FTE</span></span>`;
  }

  function optionList(values, selected, allLabel) {
    return `<option value="">${escapeHtml(allLabel)}</option>` +
      values
        .map((v) => `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(v)}</option>`)
        .join("");
  }

  function rmStaffRows(people, idPrefix) {
    return people
      .map((p) => {
        const pid = `${idPrefix}:${p.id}`;
        const open = !!(state.rmOpenStaff && state.rmOpenStaff[pid]);
        const pct = p.peakDedicatedPct;
        const w = pct == null ? 0 : Math.min(100, pct);
        const n = (p.lines || []).length;
        const windows = open
          ? (p.lines || [])
              .map((line) => {
                const lp = line.dedicatedPct;
                const lw = lp == null ? 0 : Math.min(100, lp);
                return `<div class="rm-window-row">
                  <span class="rm-staff-act">${escapeHtml(line.activity || "—")}</span>
                  <span class="rm-staff-dates">${escapeHtml((line.beginDate || "—") + " → " + (line.endDate || "—"))}</span>
                  <span class="assign-bar"><span class="dedicate-track"><span class="dedicate-fill" style="width:${lw}%"></span></span></span>
                  <span class="assign-pct">${lp == null ? "—" : lp.toFixed(1) + "%"}</span>
                </div>`;
              })
              .join("")
          : "";
        return `<button type="button" class="rm-staff-row${open ? " open" : ""}" data-staff-id="${escapeHtml(pid)}">
            <span class="rm-staff-name">${escapeHtml(p.fullName)}</span>
            <span class="rm-staff-title">${escapeHtml(p.jobTitle || "—")}</span>
            <span class="rm-staff-peak"><span class="dedicate-track"><span class="dedicate-fill" style="width:${w}%"></span></span></span>
            <span class="assign-pct">${pct == null ? "—" : pct.toFixed(1) + "%"}</span>
            <span class="rm-staff-win">${n} window${n === 1 ? "" : "s"}</span>
          </button>${windows}`;
      })
      .join("");
  }

  function rmDetails(id, open, summary, body, cls) {
    return `<details class="${cls}" data-open-id="${escapeHtml(id)}"${open ? " open" : ""}>
      <summary>${summary}</summary>
      ${body}
    </details>`;
  }

  function flattenRmFacts(studies) {
    const facts = [];
    for (const study of studies) {
      for (const role of study.roles || []) {
        for (const person of role.staff || []) {
          facts.push({ study, role, person });
        }
      }
    }
    return facts;
  }

  function layerByRole(studies) {
    const map = new Map();
    for (const f of flattenRmFacts(studies)) {
      const key = f.role.roleCode || f.role.roleId || "Unmapped";
      if (!map.has(key)) {
        map.set(key, {
          roleCode: key,
          roleGroup: f.role.roleGroup,
          studies: new Map()
        });
      }
      const node = map.get(key);
      if (!node.studies.has(f.study.studyKey)) {
        node.studies.set(f.study.studyKey, {
          studyKey: f.study.studyKey,
          studyName: f.study.studyName,
          staff: []
        });
      }
      node.studies.get(f.study.studyKey).staff.push(f.person);
    }
    return [...map.values()]
      .map((r) => {
        const studyList = [...r.studies.values()].sort((a, b) => String(a.studyKey).localeCompare(String(b.studyKey)));
        const staffIds = new Set(studyList.flatMap((s) => s.staff.map((p) => p.id)));
        return {
          roleCode: r.roleCode,
          roleGroup: r.roleGroup,
          studies: studyList,
          studyCount: studyList.length,
          staffCount: staffIds.size
        };
      })
      .sort((a, b) => String(a.roleCode).localeCompare(String(b.roleCode)));
  }

  function layerByEmployee(studies) {
    const map = new Map();
    for (const f of flattenRmFacts(studies)) {
      if (!map.has(f.person.id)) {
        map.set(f.person.id, {
          person: f.person,
          studies: new Map()
        });
      }
      const node = map.get(f.person.id);
      if (!node.studies.has(f.study.studyKey)) {
        node.studies.set(f.study.studyKey, {
          studyKey: f.study.studyKey,
          studyName: f.study.studyName,
          roles: []
        });
      }
      node.studies.get(f.study.studyKey).roles.push({
        roleCode: f.role.roleCode,
        roleId: f.role.roleId,
        roleGroup: f.role.roleGroup,
        person: f.person
      });
    }
    return [...map.values()]
      .map((n) => {
        const studyList = [...n.studies.values()].sort((a, b) => String(a.studyKey).localeCompare(String(b.studyKey)));
        return {
          person: n.person,
          studies: studyList,
          studyCount: studyList.length,
          roleCount: studyList.reduce((c, s) => c + s.roles.length, 0)
        };
      })
      .sort((a, b) => String(a.person.fullName).localeCompare(String(b.person.fullName)));
  }

  function renderRmTree(layer, studies, opts) {
    const auto = opts.autoOpen;
    if (layer === "role") {
      const roles = layerByRole(studies);
      return roles
        .map((role) => {
          const rid = `role:${role.roleCode}`;
          const open = !!state.rmOpen[rid] || !!opts.roleSel || auto || roles.length === 1;
          const inner = role.studies
            .map((study) => {
              const sid = `role-study:${role.roleCode}:${study.studyKey}`;
              const sOpen = !!state.rmOpen[sid] || !!opts.studySel || (open && role.studies.length === 1);
              return rmDetails(
                sid,
                sOpen,
                `<span class="rm-study-key">${escapeHtml(study.studyKey)}</span><span class="rm-study-name">${escapeHtml(study.studyName || "")}</span><span class="rm-study-meta">${escapeHtml(studyMetaHtml(study, study.staff.length + " staff"))}</span>`,
                `${rmActivityGantt(study)}<div class="rm-staff-head"><span>Staff</span><span>Position</span><span>Peak</span><span>%</span><span></span></div>${rmStaffRows(study.staff, sid)}`,
                "rm-role"
              );
            })
            .join("");
          return rmDetails(
            rid,
            open,
            `<span class="rm-role-code">${escapeHtml(role.roleCode)}</span><span class="rm-study-name">${escapeHtml(role.roleGroup || "Role")}</span><span class="rm-role-meta">${role.studyCount} stud${role.studyCount === 1 ? "y" : "ies"} · ${role.staffCount} staff</span>`,
            `<div class="rm-roles">${inner}</div>`,
            "rm-study"
          );
        })
        .join("");
    }
    if (layer === "employee") {
      const people = layerByEmployee(studies);
      return people
        .map((row) => {
          const eid = `emp:${row.person.id}`;
          const open = !!state.rmOpen[eid] || auto || people.length === 1;
          const inner = row.studies
            .map((study) => {
              const sid = `emp-study:${row.person.id}:${study.studyKey}`;
              const sOpen = !!state.rmOpen[sid] || !!opts.studySel || (open && row.studies.length === 1);
              const staff = study.roles.map((r) => ({
                ...r.person,
                id: `${r.person.id}:${r.roleId || r.roleCode}`,
                jobTitle: r.roleCode
              }));
              return rmDetails(
                sid,
                sOpen,
                `<span class="rm-study-key">${escapeHtml(study.studyKey)}</span><span class="rm-study-name">${escapeHtml(study.studyName || "")}</span><span class="rm-study-meta">${escapeHtml(studyMetaHtml(study, study.roles.length + " role" + (study.roles.length === 1 ? "" : "s")))}</span>`,
                `${rmActivityGantt(study)}<div class="rm-staff-head"><span>Staff</span><span>Role</span><span>Peak</span><span>%</span><span></span></div>${rmStaffRows(staff, sid)}`,
                "rm-role"
              );
            })
            .join("");
          return rmDetails(
            eid,
            open,
            `<span class="rm-study-key">${escapeHtml(row.person.fullName)}</span><span class="rm-study-name">${escapeHtml(row.person.jobTitle || "—")}</span>${utilBarHtml(opts.utilById && (opts.utilById.get(row.person.id) || opts.utilById.get(String(row.person.employeeKey || ""))))}<span class="rm-study-meta">${row.studyCount} stud${row.studyCount === 1 ? "y" : "ies"} · ${row.roleCount} role${row.roleCount === 1 ? "" : "s"}</span>`,
            `<div class="rm-roles">${inner}</div>`,
            "rm-study rm-emp"
          );
        })
        .join("");
    }
    return studies
      .map((study) => {
        const sid = `s:${study.studyKey}`;
        const studyOpen = !!state.rmOpen[sid] || !!opts.studySel || auto || studies.length === 1;
        const rolesHtml = study.roles
          .map((role) => {
            const rid = `r:${study.studyKey}:${role.roleId}`;
            const roleOpen = !!state.rmOpen[rid] || !!opts.roleSel || (studyOpen && study.roleCount === 1);
            return rmDetails(
              rid,
              roleOpen,
              `<span class="rm-role-code">${escapeHtml(role.roleCode)}</span><span class="rm-role-meta">${role.staffCount} staff${role.roleGroup ? " · " + escapeHtml(role.roleGroup) : ""}</span>`,
              `<div class="rm-staff-head"><span>Staff</span><span>Position</span><span>Peak</span><span>%</span><span></span></div>${rmStaffRows(role.staff, rid)}`,
              "rm-role"
            );
          })
          .join("");
        return rmDetails(
          sid,
          studyOpen,
          `<span class="rm-study-key">${escapeHtml(study.studyKey)}</span><span class="rm-study-name">${escapeHtml(study.studyName || "")}</span><span class="rm-study-meta">${escapeHtml(studyMetaHtml(study, study.roleCount + " role" + (study.roleCount === 1 ? "" : "s") + " · " + study.staffCount + " staff"))}</span>`,
          `${rmActivityGantt(study)}<div class="rm-roles">${rolesHtml}</div>`,
          "rm-study"
        );
      })
      .join("");
  }

  function renderRmBoard() {
    const panel = document.getElementById("viewRm");
    if (!panel) return;
    panel.classList.toggle("hidden", state.nav !== "rm");
    if (state.nav !== "rm") return;

    if (!state.rmPeople && !state.rmPeopleError) {
      panel.innerHTML = `<div class="briefing"><div class="suggest-head">RM</div><div class="briefing-note">Loading studies, roles, and staff…</div></div>`;
      return;
    }
    if (state.rmPeopleError) {
      panel.innerHTML = `<div class="briefing-note">${escapeHtml(state.rmPeopleError)}</div>`;
      return;
    }

    const pack = state.rmPeople;
    const needle = (state.rmPeopleFilter || "").trim().toLowerCase();
    const from = state.rmDateFrom || "";
    const to = state.rmDateTo || "";
    const studySel = state.rmStudy || "";
    const roleSel = state.rmRole || "";
    const posSel = state.rmPosition || "";
    const deptSel = state.rmDept || "";
    const actSel = state.rmActivity || "";
    if (!state.rmOpen) state.rmOpen = {};
    if (!state.rmOpenStaff) state.rmOpenStaff = {};

    const allStudies = pack.studies || [];
    const studySelect =
      `<option value="">All studies</option>` +
      allStudies
        .map(
          (s) =>
            `<option value="${escapeHtml(s.studyKey)}"${s.studyKey === studySel ? " selected" : ""}>${escapeHtml(s.studyKey)}${s.studyName ? " · " + escapeHtml(s.studyName) : ""}</option>`
        )
        .join("");
    const roleOptions = uniqueSorted(allStudies.flatMap((s) => (s.roles || []).map((r) => r.roleCode)));
    const posOptions = uniqueSorted(
      allStudies.flatMap((s) => (s.roles || []).flatMap((r) => (r.staff || []).map((p) => p.jobTitle)))
    );
    const deptOptions = uniqueSorted(
      allStudies.flatMap((s) => (s.roles || []).flatMap((r) => (r.staff || []).map((p) => p.department)))
    );
    const actOptions = sortActivities(
      uniqueSorted(
        allStudies.flatMap((s) =>
          (s.roles || []).flatMap((r) => (r.staff || []).flatMap((p) => (p.lines || []).map((l) => l.activity)))
        )
      )
    );

    const studies = allStudies
      .map((study) => {
        if (studySel && study.studyKey !== studySel) return null;
        const roles = (study.roles || [])
          .map((role) => {
            if (roleSel && role.roleCode !== roleSel) return null;
            const staff = (role.staff || [])
              .map((p) => {
                if (posSel && p.jobTitle !== posSel) return null;
                if (deptSel && p.department !== deptSel) return null;
                const lines = (p.lines || []).filter((l) => {
                  if (!lineOverlaps(l, from, to)) return false;
                  if (actSel && String(l.activity || "") !== actSel) return false;
                  return true;
                });
                if (!lines.length) return null;
                const hay = [
                  p.fullName,
                  p.jobTitle,
                  p.department,
                  role.roleCode,
                  study.studyKey,
                  study.studyName,
                  ...lines.map((l) => l.activity)
                ]
                  .join(" ")
                  .toLowerCase();
                if (needle && !hay.includes(needle)) return null;
                const ftes = lines.map((l) => l.valueFte).filter((n) => n != null);
                return {
                  ...p,
                  lines,
                  peakDedicatedPct: ftes.length ? Math.round(Math.max(...ftes) * 1000) / 10 : null
                };
              })
              .filter(Boolean);
            if (!staff.length) return null;
            return { ...role, staff, staffCount: staff.length };
          })
          .filter(Boolean);
        if (!roles.length) return null;
        const staffIds = new Set(roles.flatMap((r) => r.staff.map((p) => p.id)));
        return { ...study, roles, roleCount: roles.length, staffCount: staffIds.size };
      })
      .filter(Boolean);

    const staffTotal = new Set(studies.flatMap((s) => s.roles.flatMap((r) => r.staff.map((p) => p.id)))).size;
    const roleTotal = studies.reduce((n, s) => n + s.roleCount, 0);
    const minBound = pack.dateMin || "2020-01-01";
    const maxBound = pack.dateMax || "2035-12-31";
    const today = ymdLocal(new Date());
    const next12To = monthEndYmd(addMonthsYm(today.slice(0, 7), 11));
    const presetAll = !from && !to;
    const presetToday = from === today && to === today;
    const preset90 = from === today && to === addDaysYmd(today, 90);
    const preset12 = from === today && to === next12To;
    const sliced = !!(studySel || roleSel || posSel || deptSel || actSel || needle);
    const autoOpen = sliced && studies.length <= 8;
    const layer = state.rmLayer === "role" || state.rmLayer === "employee" ? state.rmLayer : "study";
    const view = state.rmView === "months" ? "months" : "tree";
    const months = monthsInView(from, to, today);
    const utilById = new Map();
    for (const p of pack.people || []) {
      if (p.id) utilById.set(p.id, p);
      if (p.employeeKey) utilById.set(String(p.employeeKey), p);
    }
    const tree =
      view === "tree"
        ? renderRmTree(layer, studies, {
            autoOpen,
            studySel,
            roleSel,
            utilById
          })
        : "";
    const calendar =
      view === "months"
        ? renderRmCalendar(layer, studies, months, {
            autoOpen,
            studySel,
            roleSel
          })
        : "";
    const roleLayerCount = layer === "role" ? layerByRole(studies).length : roleTotal;
    const empLayerCount = layer === "employee" ? layerByEmployee(studies).length : staffTotal;
    const countLabel =
      layer === "role"
        ? `${roleLayerCount} role${roleLayerCount === 1 ? "" : "s"} · ${studies.length} stud${studies.length === 1 ? "y" : "ies"} · ${staffTotal} staff`
        : layer === "employee"
          ? `${empLayerCount} people · ${studies.length} stud${studies.length === 1 ? "y" : "ies"}`
          : `${studies.length} stud${studies.length === 1 ? "y" : "ies"} · ${roleTotal} roles · ${staffTotal} staff`;
    const layerNote =
      view === "months"
        ? (layer === "study"
            ? "Study × month — FTE assigned that month. Expand a study for activities, then people. Empty cells mean nobody is booked."
            : layer === "role"
              ? "Role × month — FTE assigned that month. Expand a role for studies."
              : "Employee × month — FTE assigned that month. Expand a person for studies.") +
          (presetAll ? " Window is the next 12 months unless you set From/To." : "")
        : layer === "study"
          ? "Study → activity timeline → role → employee. Run dates are the earliest and latest assignment windows on the study."
          : layer === "role"
            ? "Role → study → employee. Study dates come from assignment windows."
            : "Employee → study → role. Study dates come from assignment windows.";

    panel.innerHTML = `<div class="rm-staffing">
      <div class="rm-filters">
        <div class="purpose rm-layer" role="tablist" aria-label="RM layering">
          <button type="button" class="purpose-btn${layer === "study" ? " active" : ""}" data-rm-layer="study">By study</button>
          <button type="button" class="purpose-btn${layer === "role" ? " active" : ""}" data-rm-layer="role">By role</button>
          <button type="button" class="purpose-btn${layer === "employee" ? " active" : ""}" data-rm-layer="employee">By employee</button>
        </div>
        <div class="purpose rm-view" role="tablist" aria-label="RM view">
          <button type="button" class="purpose-btn${view === "tree" ? " active" : ""}" data-rm-view="tree">List</button>
          <button type="button" class="purpose-btn${view === "months" ? " active" : ""}" data-rm-view="months">Months</button>
        </div>
        <div class="purpose rm-acts" role="tablist" aria-label="Activity">
          <button type="button" class="purpose-btn${!actSel ? " active" : ""}" data-rm-act="">All</button>
          ${actOptions
            .map(
              (a) =>
                `<button type="button" class="purpose-btn${actSel === a ? " active" : ""}" data-rm-act="${escapeHtml(a)}">${escapeHtml(a)}</button>`
            )
            .join("")}
        </div>
        <div class="project-toolbar rm-slice">
          <select class="project-filter rm-select" id="rmStudy" aria-label="Study">${studySelect}</select>
          <select class="project-filter rm-select" id="rmRole" aria-label="Role">${optionList(roleOptions, roleSel, "All roles")}</select>
          <select class="project-filter rm-select" id="rmPosition" aria-label="Position">${optionList(posOptions, posSel, "All positions")}</select>
          ${deptOptions.length ? `<select class="project-filter rm-select" id="rmDept" aria-label="Department">${optionList(deptOptions, deptSel, "All departments")}</select>` : ""}
        </div>
        <div class="project-toolbar">
          <input class="project-filter" id="rmPeopleFilter" type="search" placeholder="Jump to a name, study, role, or activity…" value="${escapeHtml(state.rmPeopleFilter)}" />
          <span class="project-count">${countLabel}</span>
        </div>
        <div class="project-toolbar rm-datebar">
          <label class="rm-date-label">From <input class="project-filter rm-date" id="rmDateFrom" type="date" min="${escapeHtml(minBound)}" max="${escapeHtml(maxBound)}" value="${escapeHtml(from)}" /></label>
          <label class="rm-date-label">To <input class="project-filter rm-date" id="rmDateTo" type="date" min="${escapeHtml(minBound)}" max="${escapeHtml(maxBound)}" value="${escapeHtml(to)}" /></label>
          <button type="button" class="purpose-btn${presetAll ? " active" : ""}" data-rm-preset="all">All dates</button>
          <button type="button" class="purpose-btn${presetToday ? " active" : ""}" data-rm-preset="today">As of today</button>
          <button type="button" class="purpose-btn${preset90 ? " active" : ""}" data-rm-preset="next90">Next 90 days</button>
          <button type="button" class="purpose-btn${preset12 ? " active" : ""}" data-rm-preset="next12">Next 12 months</button>
          <button type="button" class="purpose-btn" id="rmExpand">Expand shown</button>
          <button type="button" class="purpose-btn" id="rmCollapse">Collapse</button>
        </div>
      </div>
      <p class="rm-layer-note">${escapeHtml(layerNote)}</p>
      ${
        view === "months"
          ? calendar || `<p class="empty">No assignments overlap this month window.</p>`
          : `<div class="rm-tree">${tree || `<p class="empty">No assignments overlap this filter.</p>`}</div>`
      }
    </div>
    <div class="briefing-note" style="margin-top:12px">${escapeHtml(pack.note || "")}</div>`;

    const bindSelect = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.onchange = (e) => {
        state[key] = e.target.value;
        renderRmBoard();
        const again = document.getElementById(id);
        if (again) again.focus();
      };
    };
    bindSelect("rmStudy", "rmStudy");
    bindSelect("rmRole", "rmRole");
    bindSelect("rmPosition", "rmPosition");
    bindSelect("rmDept", "rmDept");
    panel.querySelectorAll("[data-rm-act]").forEach((btn) => {
      btn.onclick = () => {
        state.rmActivity = btn.dataset.rmAct || "";
        renderRmBoard();
      };
    });
    panel.querySelectorAll("[data-rm-layer]").forEach((btn) => {
      btn.onclick = () => {
        const next = btn.dataset.rmLayer;
        if (state.rmLayer === next) return;
        state.rmLayer = next;
        state.rmOpen = {};
        state.rmOpenStaff = {};
        renderRmBoard();
      };
    });
    panel.querySelectorAll("[data-rm-view]").forEach((btn) => {
      btn.onclick = () => {
        const next = btn.dataset.rmView === "months" ? "months" : "tree";
        if (state.rmView === next) return;
        state.rmView = next;
        renderRmBoard();
      };
    });
    const filter = document.getElementById("rmPeopleFilter");
    if (filter) {
      filter.oninput = (e) => {
        state.rmPeopleFilter = e.target.value;
        const pos = e.target.selectionStart;
        renderRmBoard();
        restoreRmField("rmPeopleFilter", pos);
      };
    }
    const fromEl = document.getElementById("rmDateFrom");
    const toEl = document.getElementById("rmDateTo");
    if (fromEl) {
      fromEl.onchange = (e) => {
        state.rmDateFrom = e.target.value;
        renderRmBoard();
        restoreRmField("rmDateFrom");
      };
    }
    if (toEl) {
      toEl.onchange = (e) => {
        state.rmDateTo = e.target.value;
        renderRmBoard();
        restoreRmField("rmDateTo");
      };
    }
    panel.querySelectorAll("[data-rm-preset]").forEach((btn) => {
      btn.onclick = () => {
        const p = btn.dataset.rmPreset;
        if (p === "today") {
          state.rmDateFrom = today;
          state.rmDateTo = today;
        } else if (p === "next90") {
          state.rmDateFrom = today;
          state.rmDateTo = addDaysYmd(today, 90);
        } else if (p === "next12") {
          state.rmDateFrom = today;
          state.rmDateTo = next12To;
        } else {
          state.rmDateFrom = "";
          state.rmDateTo = "";
        }
        renderRmBoard();
      };
    });
    const expand = document.getElementById("rmExpand");
    const collapse = document.getElementById("rmCollapse");
    if (expand) {
      expand.onclick = () => {
        panel.querySelectorAll("details[data-open-id]").forEach((el) => {
          state.rmOpen[el.dataset.openId] = true;
        });
        panel.querySelectorAll("[data-cal-open]").forEach((el) => {
          state.rmOpen[el.dataset.calOpen] = true;
        });
        renderRmBoard();
      };
    }
    if (collapse) {
      collapse.onclick = () => {
        state.rmOpen = {};
        state.rmOpenStaff = {};
        renderRmBoard();
      };
    }
    panel.querySelectorAll("details[data-open-id]").forEach((el) => {
      el.addEventListener("toggle", () => {
        state.rmOpen[el.dataset.openId] = el.open;
      });
    });
    panel.querySelectorAll("[data-staff-id]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.staffId;
        state.rmOpenStaff[id] = !state.rmOpenStaff[id];
        renderRmBoard();
      };
    });
    panel.querySelectorAll("[data-cal-open]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.calOpen;
        state.rmOpen[id] = !state.rmOpen[id];
        renderRmBoard();
      };
    });
  }

  async function loadRmPeople() {
    if (state.rmPeople && state.rmPeople.loaded) return;
    try {
      const res = await fetch("/api/rm/people");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `RM people failed (${res.status})`);
      state.rmPeople = body.people || body;
      state.rmPeopleError = "";
    } catch (err) {
      state.rmPeopleError = String(err.message || err);
      state.rmPeople = null;
    }
    if (state.nav === "rm") render();
  }

  function renderLists() {
    const saved = document.getElementById("viewSaved");
    const hist = document.getElementById("viewHistory");
    const help = document.getElementById("viewSourcesHelp");
    const ctx = document.getElementById("viewContext");
    const ask = document.getElementById("viewAsk");
    const rm = document.getElementById("viewRm");

    ask.classList.toggle("hidden", state.nav !== "ask");
    saved.classList.toggle("hidden", state.nav !== "saved");
    hist.classList.toggle("hidden", state.nav !== "history");
    help.classList.toggle("hidden", state.nav !== "sources");
    if (ctx) ctx.classList.toggle("hidden", state.nav !== "context");
    if (rm) rm.classList.toggle("hidden", state.nav !== "rm");

    const idleTitle =
      state.purpose === "finance"
        ? "Finance"
        : state.purpose === "bd"
          ? "Business development"
          : state.purpose === "staffing"
            ? "RM"
            : "ClinOps briefing";
    const titles = {
      ask:
        state.phase === "project"
          ? state.projectNumber || "Project"
          : state.phase === "idle"
            ? idleTitle
            : "Ask your data",
      saved: "Saved answers",
      history: "History",
      sources: "Sources",
      context: "My context",
      rm: "Resource management"
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
        state.thread = [];
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
        state.thread = [];
        run(s.key, s.text);
      };
    });

    help.innerHTML = `<div class="answer">
      <p class="summary">Sources are display-only. Purpose (ClinOps / Finance / RM / BD) sets what is in scope for Ask. After an answer, referenced packs light up and the rest go grey — including anything not used for that question. ClinOps reads live ora_veeva_* (study / site / milestone / subject). Salesforce pipeline uses Total_Ora_Net_Revenue__c only. InsightsRM is actual RM data in lens_rm_* until the DW feed exists — not NetSuite, not a mock.</p>
      <p class="caveat">Blank enrolled or GM is missing, not zero. PSM needs FSI and LSI from ora_veeva_milestone — missing dates stay null. Project number joins to ora_veeva_study.study_number in the app — no mapping table. Ask never writes warehouse containers and never falls back to ora_fact_* Excel dumps. Your Entra preference lives in lens_user_prefs and only frames the narrative.</p>
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
    draft.placeholder =
      state.projectNumber
        ? `Ask about ${state.projectNumber} — GM, enrollment, sites…`
        : state.purpose === "finance"
          ? "Ask about GM, change orders, or a project number…"
          : state.purpose === "staffing"
            ? "Ask about FTE, assignments, CRA capacity, or a study key…"
            : "Ask from the loaded Cosmos sources — or pick a purpose above.";
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
    const brand = document.getElementById("brandHome");
    if (brand) brand.onclick = toggleTheme;
    const mobileBrand = document.getElementById("mobileBrandHome");
    if (mobileBrand) mobileBrand.onclick = toggleTheme;
    const navToggle = document.getElementById("btnMobileNav");
    if (navToggle) {
      navToggle.onclick = () => setMobileDrawer("nav");
    }
    const sourcesToggle = document.getElementById("btnMobileSources");
    if (sourcesToggle) {
      sourcesToggle.onclick = () => setMobileDrawer("sources");
    }
    const backdrop = document.getElementById("drawerBackdrop");
    if (backdrop) {
      backdrop.onclick = () => closeMobileDrawers();
    }
    if (!window.__odlMobileBound) {
      window.__odlMobileBound = true;
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMobileDrawers();
      });
      window.matchMedia("(min-width: 981px)").addEventListener("change", (ev) => {
        if (ev.matches) closeMobileDrawers();
      });
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (ev) => {
        const stored = load("odl.theme", "");
        if (stored === "dark" || stored === "light") return;
        applyTheme(ev.matches ? "dark" : "light", false);
        render();
      });
    }
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
    applyTheme(currentTheme(), false);
    renderNav();
    renderPurpose();
    renderSources();
    renderIdle();
    renderThinking();
    renderAnswer();
    renderProject();
    renderLists();
    renderRmBoard();
    renderContext();
    bindChrome();
  }

  async function loadBriefing() {
    try {
      const res = await fetch("/api/briefing");
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.briefing) state.briefing = body.briefing;
    } catch (_) {
      state.briefing = null;
    }
    if (state.phase === "idle") render();
  }

  async function loadFinance() {
    try {
      const res = await fetch("/api/finance");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Finance failed (${res.status})`);
      state.finance = body.finance || null;
    } catch (err) {
      state.finance = {
        loaded: false,
        projects: 0,
        uniqueNumbers: 0,
        withGm: 0,
        missingGm: 0,
        underGm: 0,
        linked: 0,
        unlinked: 0,
        rows: [],
        note: String(err.message || err)
      };
    }
    if (state.phase === "idle" && state.purpose === "finance") render();
  }

  async function loadRm() {
    try {
      const res = await fetch("/api/rm");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `RM briefing failed (${res.status})`);
      state.rm = body.rm || null;
    } catch (err) {
      state.rm = {
        loaded: false,
        overCount: 0,
        shortRoles: 0,
        studies: 0,
        employees: 0,
        assignments: 0,
        note: String(err.message || err)
      };
    }
    if (state.phase === "idle" && state.purpose === "staffing") render();
  }

  async function openProject(number) {
    const pn = String(number || "").trim();
    if (!pn) return;
    state.nav = "ask";
    state.phase = "project";
    state.projectNumber = pn;
    state.project = null;
    state.projectError = "";
    if (state.purpose !== "finance") {
      applyPurposeSources("finance");
      save("odl.purpose", "finance");
    }
    render();
    try {
      const res = await fetch(`/api/project?number=${encodeURIComponent(pn)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Project failed (${res.status})`);
      state.project = body.project;
    } catch (err) {
      state.projectError = String(err.message || err);
    }
    render();
  }

  applyPurposeSources(state.purpose);
  render();
  loadBriefing();
  loadFinance();
  loadRm();
  loadViewer();
})();
