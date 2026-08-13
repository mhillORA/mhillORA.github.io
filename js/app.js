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
    project: null,
    projectNumber: "",
    projectFilter: "",
    projectError: "",
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
    const staffing = ["staff", "resource", "cra", "fte", "capacity", "assign", "backfill", "rolls off", "headcount"];
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
    render();
  }

  function resetAsk() {
    state.phase = "idle";
    state.draft = "";
    state.traceOpen = false;
    state.nav = "ask";
    state.project = null;
    state.projectNumber = "";
    state.projectError = "";
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
          sources: enabledList().map((s) => s.id),
          projectNumber: state.projectNumber || ""
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
      : "No loaded sources selected — pick at least one to ask a question.";
    document.getElementById("enabledCount").textContent = `${enabledList().length} of ${loadedSources().length} loaded sources in scope`;
    const asOf = state.briefing && state.briefing.asOfLabel ? state.briefing.asOfLabel : "as-of pending";
    document.getElementById("scopeLine").textContent = `${enabledList().length} loaded sources · ${asOf}`;

    document.getElementById("workspaces").innerHTML = WORKSPACES.map(
      (w) =>
        `<button type="button" class="chip${state.workspace === w.id ? " active" : ""}" data-ws="${w.id}">${w.label}</button>`
    ).join("");
    document.querySelectorAll("[data-ws]").forEach((btn) => {
      btn.onclick = () => {
        const w = WORKSPACES.find((x) => x.id === btn.dataset.ws);
        SOURCES.forEach((s) => {
          state.enabled[s.id] = s.loaded && w.ids.includes(s.id);
        });
        state.workspace = w.id;
        if (w.id === "finance" || w.id === "clinops" || w.id === "bd") {
          state.purpose = w.id;
          save("odl.purpose", w.id);
        }
        render();
        if (w.id === "finance") loadFinance();
      };
    });

    document.getElementById("sourceList").innerHTML = SOURCES.map((s) => {
      const on = s.loaded && state.enabled[s.id];
      const locked = !s.loaded;
      return `<button type="button" class="source-card${on ? " on" : ""}${locked ? " locked" : ""}" data-src="${s.id}" ${locked ? "disabled" : ""}>
        <span class="check">${on ? "✓" : locked ? "–" : ""}</span>
        <span style="min-width:0;flex:1">
          <span class="source-top"><span class="source-name">${s.name}</span><span class="source-sync${s.fresh ? "" : " stale"}">${locked ? "not loaded" : s.sync}</span></span>
          <span class="source-cat">${s.cat}</span>
          <span class="source-scope">${s.scope}</span>
        </span>
      </button>`;
    }).join("");
    document.querySelectorAll("[data-src]").forEach((btn) => {
      btn.onclick = () => {
        const src = sourceById(btn.dataset.src);
        if (!src || !src.loaded) return;
        state.enabled[btn.dataset.src] = !state.enabled[btn.dataset.src];
        state.workspace = null;
        render();
      };
    });
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
      <div class="thinking-row"><span class="dot"></span><span>Reading Cosmos · asking Foundry</span></div>
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
    const missingNames = missing.map((id) => sourceById(id).name);
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
    const keys = a.projectKeys || [];
    const rows = a.rows
      .map((r, ri) => {
        const pn = keys[ri] || "";
        return `<div class="table-row${pn ? " clickable" : ""}"${pn ? ` data-pn="${escapeHtml(pn)}"` : ""} style="grid-template-columns:${a.grid}">${r
          .map((cell, i) => `<span class="${i === 0 ? "cell-strong" : i < 3 ? "cell-mono" : ""}">${cell}</span>`)
          .join("")}</div>`;
      })
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
      ${missingBanner}
      <div class="answer">
        <div class="answer-head">
          <span class="conf" style="background:${conf.bg};color:${conf.color}"><span class="conf-dot" style="background:${conf.color}"></span>${conf.label}</span>
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
        <div class="thinking-row"><span class="dot"></span><span>Joining NetSuite to ora_fact_study…</span></div>
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
      : `<p class="empty">No ora_fact_study.study_number matched ${escapeHtml(p.project_number)}.</p>`;

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
          <span class="block-title">ora_fact_study (${studies.length}) · joined on study_number</span>
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
          <span class="block-title">ora_fact_site (${sites.length})</span>
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

    const idleTitle =
      state.purpose === "finance" ? "Finance" : state.purpose === "bd" ? "Business development" : "ClinOps briefing";
    const titles = {
      ask:
        state.phase === "project"
          ? state.projectNumber || "Project"
          : state.phase === "idle"
            ? idleTitle
            : "Ask your data",
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
      <p class="summary">Loaded sources: Ora clinical rollup, TrialHub, CT.gov, Salesforce crosswalk, NetSuite profitability. Veeva / live EDC / InsightsRM stay locked until gold ETL. Ask never writes. Project number joins to ora_fact_study.study_number in the app — there is no mapping table.</p>
      <p class="caveat">Blank enrolled or GM is missing, not zero. Chart bars use known values only. As-of is the newest document timestamp in the pack.</p>
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
    renderPurpose();
    renderSources();
    renderIdle();
    renderThinking();
    renderAnswer();
    renderProject();
    renderLists();
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
})();
