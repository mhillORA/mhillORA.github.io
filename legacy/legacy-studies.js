/**
 * ARTEMIS Legacy Studies + Legacy Reporting (site-study outcomes only).
 * Loaded only by ARTEMIS index.html — not CHAOS / NASA.
 */
(function (global) {
  const state = {
    studies: [],
    outcomes: [],
    loaded: false,
    selectedStudyId: null,
  };

  function apiBase() {
    return (global.apiService && global.apiService.baseUrl) || '/api';
  }

  async function req(path, options = {}) {
    if (global.apiService && typeof global.apiService.request === 'function') {
      return global.apiService.request(path.startsWith('/') ? path : `/${path}`, {
        method: options.method || 'GET',
        body: options.body,
      });
    }
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!res.ok) throw new Error(await res.text());
    if (res.status === 204) return null;
    return res.json();
  }

  async function ensureLoaded(force = false) {
    if (state.loaded && !force) return state;
    const [studies, outcomes] = await Promise.all([
      req('/legacy-studies').catch((e) => {
        console.error('legacy-studies load failed', e);
        return [];
      }),
      req('/legacy-study-site-outcomes').catch((e) => {
        console.error('legacy outcomes load failed', e);
        return [];
      }),
    ]);
    state.studies = Array.isArray(studies) ? studies : [];
    state.outcomes = Array.isArray(outcomes) ? outcomes : [];
    state.loaded = true;
    console.log('Legacy loaded', state.studies.length, 'studies,', state.outcomes.length, 'site rows');
    return state;
  }

  async function fetchOutcomesForStudy(studyId) {
    const cached = state.outcomes.filter((o) => o.studyId === studyId);
    if (cached.length) return cached;
    const rows = await req(
      `/legacy-study-site-outcomes?studyId=${encodeURIComponent(studyId)}`
    ).catch((e) => {
      console.error('study outcomes fetch failed', e);
      return [];
    });
    const list = Array.isArray(rows) ? rows : [];
    // merge into cache
    const others = state.outcomes.filter((o) => o.studyId !== studyId);
    state.outcomes = others.concat(list);
    return list;
  }

  function fmt(n) {
    if (n == null || n === '') return '—';
    const x = Number(n);
    if (Number.isNaN(x)) return String(n);
    return x.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function rate(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (!y || Number.isNaN(x) || Number.isNaN(y)) return '—';
    return `${((x / y) * 100).toFixed(1)}%`;
  }

  function num(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }

  /** Normalize outcome fields (tolerate older/alternate shapes). */
  function normOutcome(o) {
    return {
      id: o.id,
      studyId: o.studyId,
      studyName: o.studyName || o.study || '',
      siteName: o.siteName || o.site || '',
      group: o.group ?? o.groupNumber ?? o.Group ?? null,
      pi: o.pi || o.PI || '',
      visit1Start: o.visit1Start || o.visit1_start || o.Visit1Start || '',
      lplv: o.lplv || o.LPLV || '',
      targetScheduled: o.targetScheduled ?? o.target_scheduled ?? null,
      scheduled: o.scheduled ?? null,
      screened: o.screened ?? o.screen ?? null,
      enrolled: o.enrolled ?? null,
      uniqueId: o.uniqueId || '',
    };
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sumOutcomes(rows) {
    return rows.reduce(
      (a, raw) => {
        const o = normOutcome(raw);
        a.targetScheduled += num(o.targetScheduled);
        a.scheduled += num(o.scheduled);
        a.screened += num(o.screened);
        a.enrolled += num(o.enrolled);
        if (o.siteName) a.sites.add(o.siteName);
        if (o.pi) a.pis.add(o.pi);
        if (o.visit1Start) a.visitStarts.push(o.visit1Start);
        if (o.lplv) a.lplvs.push(o.lplv);
        return a;
      },
      {
        targetScheduled: 0,
        scheduled: 0,
        screened: 0,
        enrolled: 0,
        sites: new Set(),
        pis: new Set(),
        visitStarts: [],
        lplvs: [],
      }
    );
  }

  /** Roll site rows up to one row per site (sums groups). */
  function bySiteRollup(rows) {
    const map = {};
    for (const raw of rows) {
      const o = normOutcome(raw);
      const key = o.siteName || '(unknown site)';
      if (!map[key]) {
        map[key] = {
          siteName: key,
          groups: [],
          pis: new Set(),
          targetScheduled: 0,
          scheduled: 0,
          screened: 0,
          enrolled: 0,
          visit1StartMin: null,
          visit1StartMax: null,
          lplvMin: null,
          lplvMax: null,
          rows: [],
        };
      }
      const s = map[key];
      s.rows.push(o);
      if (o.group != null && o.group !== '') s.groups.push(o.group);
      if (o.pi) s.pis.add(o.pi);
      s.targetScheduled += num(o.targetScheduled);
      s.scheduled += num(o.scheduled);
      s.screened += num(o.screened);
      s.enrolled += num(o.enrolled);
      if (o.visit1Start) {
        if (!s.visit1StartMin || o.visit1Start < s.visit1StartMin) s.visit1StartMin = o.visit1Start;
        if (!s.visit1StartMax || o.visit1Start > s.visit1StartMax) s.visit1StartMax = o.visit1Start;
      }
      if (o.lplv) {
        if (!s.lplvMin || o.lplv < s.lplvMin) s.lplvMin = o.lplv;
        if (!s.lplvMax || o.lplv > s.lplvMax) s.lplvMax = o.lplv;
      }
    }
    return Object.values(map)
      .map((s) => ({
        ...s,
        piList: [...s.pis].join(', '),
        groupList: s.groups.length ? [...new Set(s.groups)].join(', ') : '—',
      }))
      .sort((a, b) => b.enrolled - a.enrolled);
  }

  function siteOutcomesTableHtml(rows, { showStudy = false } = {}) {
    const normalized = rows.map(normOutcome).sort((a, b) => {
      const sn = String(a.siteName).localeCompare(String(b.siteName));
      if (sn !== 0) return sn;
      return num(b.enrolled) - num(a.enrolled);
    });
    if (!normalized.length) {
      return `<div class="p-4 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-md">
        No site-level outcome rows loaded for this selection. Try Refresh. If this persists, re-run the legacy ingest.
      </div>`;
    }
    const totals = sumOutcomes(normalized);
    return `
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-900/50 text-left">
            <tr>
              ${showStudy ? '<th class="px-2 py-2">Study</th>' : ''}
              <th class="px-2 py-2">Site</th>
              <th class="px-2 py-2">Group</th>
              <th class="px-2 py-2">PI</th>
              <th class="px-2 py-2">Visit 1</th>
              <th class="px-2 py-2">LPLV</th>
              <th class="px-2 py-2 text-right">Target Sched</th>
              <th class="px-2 py-2 text-right">Scheduled</th>
              <th class="px-2 py-2 text-right">Screened</th>
              <th class="px-2 py-2 text-right">Enrolled</th>
              <th class="px-2 py-2 text-right">Sched/Target</th>
              <th class="px-2 py-2 text-right">Screen/Sched</th>
              <th class="px-2 py-2 text-right">Enroll/Screen</th>
            </tr>
          </thead>
          <tbody>
            ${normalized
              .map(
                (o) => `<tr class="border-t dark:border-gray-700">
                ${showStudy ? `<td class="px-2 py-1.5">${escapeHtml(o.studyName)}</td>` : ''}
                <td class="px-2 py-1.5 font-medium">${escapeHtml(o.siteName || '—')}</td>
                <td class="px-2 py-1.5">${o.group == null || o.group === '' ? '—' : escapeHtml(o.group)}</td>
                <td class="px-2 py-1.5">${escapeHtml(o.pi || '—')}</td>
                <td class="px-2 py-1.5 whitespace-nowrap">${escapeHtml(o.visit1Start || '—')}</td>
                <td class="px-2 py-1.5 whitespace-nowrap">${escapeHtml(o.lplv || '—')}</td>
                <td class="px-2 py-1.5 text-right">${fmt(o.targetScheduled)}</td>
                <td class="px-2 py-1.5 text-right">${fmt(o.scheduled)}</td>
                <td class="px-2 py-1.5 text-right">${fmt(o.screened)}</td>
                <td class="px-2 py-1.5 text-right font-semibold">${fmt(o.enrolled)}</td>
                <td class="px-2 py-1.5 text-right">${rate(o.scheduled, o.targetScheduled)}</td>
                <td class="px-2 py-1.5 text-right">${rate(o.screened, o.scheduled)}</td>
                <td class="px-2 py-1.5 text-right">${rate(o.enrolled, o.screened)}</td>
              </tr>`
              )
              .join('')}
            <tr class="border-t-2 dark:border-gray-500 bg-gray-50 dark:bg-gray-900/40 font-semibold">
              ${showStudy ? '<td class="px-2 py-2"></td>' : ''}
              <td class="px-2 py-2" colspan="5">Total (${normalized.length} rows · ${totals.sites.size} sites)</td>
              <td class="px-2 py-2 text-right">${fmt(totals.targetScheduled)}</td>
              <td class="px-2 py-2 text-right">${fmt(totals.scheduled)}</td>
              <td class="px-2 py-2 text-right">${fmt(totals.screened)}</td>
              <td class="px-2 py-2 text-right">${fmt(totals.enrolled)}</td>
              <td class="px-2 py-2 text-right">${rate(totals.scheduled, totals.targetScheduled)}</td>
              <td class="px-2 py-2 text-right">${rate(totals.screened, totals.scheduled)}</td>
              <td class="px-2 py-2 text-right">${rate(totals.enrolled, totals.screened)}</td>
            </tr>
          </tbody>
        </table>
      </div>`;
  }

  function siteRollupTableHtml(rows) {
    const sites = bySiteRollup(rows);
    if (!sites.length) {
      return `<div class="p-4 text-sm text-gray-500">No sites to roll up.</div>`;
    }
    return `
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-900/50 text-left">
            <tr>
              <th class="px-2 py-2">Site</th>
              <th class="px-2 py-2">Group(s)</th>
              <th class="px-2 py-2">PI(s)</th>
              <th class="px-2 py-2">Visit 1 range</th>
              <th class="px-2 py-2">LPLV range</th>
              <th class="px-2 py-2 text-right">Target</th>
              <th class="px-2 py-2 text-right">Scheduled</th>
              <th class="px-2 py-2 text-right">Screened</th>
              <th class="px-2 py-2 text-right">Enrolled</th>
              <th class="px-2 py-2 text-right">E/S</th>
              <th class="px-2 py-2 text-right">% of study enroll</th>
            </tr>
          </thead>
          <tbody>
            ${(() => {
              const studyEnroll = sites.reduce((a, s) => a + s.enrolled, 0) || 1;
              return sites
                .map(
                  (s) => `<tr class="border-t dark:border-gray-700">
                  <td class="px-2 py-1.5 font-medium">${escapeHtml(s.siteName)}</td>
                  <td class="px-2 py-1.5">${escapeHtml(s.groupList)}</td>
                  <td class="px-2 py-1.5">${escapeHtml(s.piList || '—')}</td>
                  <td class="px-2 py-1.5 text-xs whitespace-nowrap">${escapeHtml(
                    [s.visit1StartMin, s.visit1StartMax].filter(Boolean).join(' → ') || '—'
                  )}</td>
                  <td class="px-2 py-1.5 text-xs whitespace-nowrap">${escapeHtml(
                    [s.lplvMin, s.lplvMax].filter(Boolean).join(' → ') || '—'
                  )}</td>
                  <td class="px-2 py-1.5 text-right">${fmt(s.targetScheduled)}</td>
                  <td class="px-2 py-1.5 text-right">${fmt(s.scheduled)}</td>
                  <td class="px-2 py-1.5 text-right">${fmt(s.screened)}</td>
                  <td class="px-2 py-1.5 text-right font-semibold">${fmt(s.enrolled)}</td>
                  <td class="px-2 py-1.5 text-right">${rate(s.enrolled, s.screened)}</td>
                  <td class="px-2 py-1.5 text-right">${rate(s.enrolled, studyEnroll)}</td>
                </tr>`
                )
                .join('');
            })()}
          </tbody>
        </table>
      </div>`;
  }

  function getLegacyStudiesHTML() {
    return `
      <div class="space-y-4" id="legacy-studies-root">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Legacy Studies</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Site–study outcomes from Anterior Segment Overview. Open a study for full site / PI / Visit1 / LPLV breakdown.
            </p>
          </div>
          <div class="flex gap-2">
            <input id="legacy-study-search" type="search" placeholder="Search studies…"
              class="px-3 py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-sm w-56" />
            <button id="legacy-studies-refresh" class="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Refresh</button>
          </div>
        </div>
        <div id="legacy-studies-summary" class="grid grid-cols-2 md:grid-cols-5 gap-3"></div>
        <div id="legacy-load-status" class="text-xs text-gray-500"></div>
        <div id="legacy-studies-table-wrap" class="overflow-x-auto rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800"></div>
        <div id="legacy-study-detail" class="hidden"></div>
      </div>`;
  }

  function getLegacyReportingHTML() {
    return `
      <div class="space-y-4" id="legacy-reporting-root">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Legacy Reporting</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Funnel metrics with study → site breakdowns (Group, PI, Visit 1, LPLV).
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <select id="legacy-report-study" class="px-3 py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-sm min-w-[12rem]">
              <option value="">All studies (summary)</option>
            </select>
            <select id="legacy-report-ta" class="px-3 py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-sm">
              <option value="">All therapeutic areas</option>
            </select>
            <button id="legacy-report-refresh" class="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Refresh</button>
            <button id="legacy-report-export" class="px-3 py-2 text-sm rounded-md border dark:border-gray-600">Export CSV</button>
          </div>
        </div>
        <div id="legacy-report-kpis" class="grid grid-cols-2 md:grid-cols-6 gap-3"></div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2 text-gray-900 dark:text-white">Enrolled by study</h3>
            <canvas id="legacy-chart-studies" height="220"></canvas>
          </div>
          <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
            <h3 class="font-semibold mb-2 text-gray-900 dark:text-white">Funnel totals</h3>
            <canvas id="legacy-chart-funnel" height="220"></canvas>
          </div>
        </div>
        <div id="legacy-report-tables" class="space-y-4"></div>
      </div>`;
  }

  function summaryCards(el, studies) {
    const m = studies.reduce(
      (a, s) => {
        const x = s.metrics || {};
        a.enrolled += num(x.enrolled);
        a.screened += num(x.screened);
        a.scheduled += num(x.scheduled);
        a.target += num(x.targetScheduled);
        return a;
      },
      { enrolled: 0, screened: 0, scheduled: 0, target: 0 }
    );
    el.innerHTML = [
      ['Studies', studies.length],
      ['Site outcome rows', state.outcomes.length],
      ['Scheduled', fmt(m.scheduled)],
      ['Screened', fmt(m.screened)],
      ['Enrolled', fmt(m.enrolled)],
    ]
      .map(
        ([label, val]) => `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <div class="text-xs text-gray-500 dark:text-gray-400">${label}</div>
        <div class="text-xl font-semibold text-gray-900 dark:text-white">${val}</div>
      </div>`
      )
      .join('');
  }

  function renderStudiesTable(q = '') {
    const wrap = document.getElementById('legacy-studies-table-wrap');
    const summary = document.getElementById('legacy-studies-summary');
    const status = document.getElementById('legacy-load-status');
    if (!wrap) return;
    if (status) {
      status.textContent = `Loaded ${state.studies.length} studies · ${state.outcomes.length} site–study rows from Cosmos`;
    }
    const qq = q.trim().toLowerCase();
    const rows = state.studies
      .filter((s) => {
        if (!qq) return true;
        const blob = `${s.name} ${s.title} ${s.therapeuticArea || ''} ${s.indication || ''}`.toLowerCase();
        return blob.includes(qq);
      })
      .sort((a, b) => num(b.metrics?.enrolled) - num(a.metrics?.enrolled));

    if (summary) summaryCards(summary, state.studies);

    wrap.innerHTML = `
      <table class="min-w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-900/50 text-left">
          <tr>
            <th class="px-3 py-2">Study</th>
            <th class="px-3 py-2">Therapeutic Area</th>
            <th class="px-3 py-2">Indication</th>
            <th class="px-3 py-2 text-right">Sites</th>
            <th class="px-3 py-2 text-right">Scheduled</th>
            <th class="px-3 py-2 text-right">Screened</th>
            <th class="px-3 py-2 text-right">Enrolled</th>
            <th class="px-3 py-2 text-right">E/S</th>
            <th class="px-3 py-2">Visit1 range</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((s) => {
              const m = s.metrics || {};
              const siteCount = state.outcomes.filter((o) => o.studyId === s.id).length;
              return `<tr class="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                <td class="px-3 py-2 font-medium text-gray-900 dark:text-white">${escapeHtml(s.name || s.title)}</td>
                <td class="px-3 py-2">${escapeHtml(s.therapeuticArea || '—')}</td>
                <td class="px-3 py-2">${escapeHtml(s.indication || '—')}</td>
                <td class="px-3 py-2 text-right">${fmt(m.nSites ?? siteCount)}</td>
                <td class="px-3 py-2 text-right">${fmt(m.scheduled)}</td>
                <td class="px-3 py-2 text-right">${fmt(m.screened)}</td>
                <td class="px-3 py-2 text-right font-semibold">${fmt(m.enrolled)}</td>
                <td class="px-3 py-2 text-right">${rate(m.enrolled, m.screened)}</td>
                <td class="px-3 py-2 text-xs text-gray-500">${escapeHtml(
                  [m.visit1StartMin, m.visit1StartMax].filter(Boolean).join(' → ') || '—'
                )}</td>
                <td class="px-3 py-2 text-right">
                  <button data-legacy-open="${escapeHtml(s.id)}" class="text-indigo-600 hover:underline">Open sites</button>
                </td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('[data-legacy-open]').forEach((btn) => {
      btn.addEventListener('click', () => openStudyDetail(btn.getAttribute('data-legacy-open')));
    });
  }

  async function openStudyDetail(studyId) {
    state.selectedStudyId = studyId;
    const study = state.studies.find((s) => s.id === studyId);
    const detail = document.getElementById('legacy-study-detail');
    const tableWrap = document.getElementById('legacy-studies-table-wrap');
    const summary = document.getElementById('legacy-studies-summary');
    if (!detail || !study) return;

    if (tableWrap) tableWrap.classList.add('hidden');
    if (summary) summary.classList.add('hidden');
    detail.classList.remove('hidden');
    detail.innerHTML = `<div class="p-6 text-sm text-gray-500">Loading site outcomes for ${escapeHtml(study.name)}…</div>`;

    const outcomes = await fetchOutcomesForStudy(studyId);
    const m = study.metrics || {};
    const totals = sumOutcomes(outcomes);

    detail.innerHTML = `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <button id="legacy-back-list" class="text-sm text-indigo-600 hover:underline mb-1">← All legacy studies</button>
            <h3 class="text-xl font-bold text-gray-900 dark:text-white">${escapeHtml(study.name)}</h3>
            <p class="text-sm text-gray-500">
              Visit 1 ${escapeHtml(m.visit1StartMin || totals.visitStarts.sort()[0] || '—')}
              → ${escapeHtml(m.visit1StartMax || totals.visitStarts.sort().slice(-1)[0] || '—')}
              · LPLV ${escapeHtml(m.lplvMin || '—')} → ${escapeHtml(m.lplvMax || '—')}
              · ${outcomes.length} site row(s)
            </p>
          </div>
          <button id="legacy-save-meta" class="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white">Save metadata</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label class="text-sm">Therapeutic Area
            <input id="legacy-meta-ta" class="mt-1 w-full px-2 py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600"
              value="${escapeHtml(study.therapeuticArea || '')}" placeholder="e.g. Dry Eye, Allergy" />
          </label>
          <label class="text-sm">Indication
            <input id="legacy-meta-indication" class="mt-1 w-full px-2 py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600"
              value="${escapeHtml(study.indication || '')}" />
          </label>
          <label class="text-sm">Sponsor
            <input id="legacy-meta-sponsor" class="mt-1 w-full px-2 py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600"
              value="${escapeHtml(study.sponsor || '')}" />
          </label>
          <label class="text-sm">Phase
            <input id="legacy-meta-phase" class="mt-1 w-full px-2 py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600"
              value="${escapeHtml(study.phase || '')}" />
          </label>
          <label class="text-sm">Status
            <input id="legacy-meta-status" class="mt-1 w-full px-2 py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600"
              value="${escapeHtml(study.status || '')}" />
          </label>
          <label class="text-sm md:col-span-3">Notes
            <textarea id="legacy-meta-notes" rows="2" class="mt-1 w-full px-2 py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600">${escapeHtml(
              study.notes || ''
            )}</textarea>
          </label>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
          <div><div class="text-gray-500">Target sched</div><div class="font-semibold">${fmt(totals.targetScheduled || m.targetScheduled)}</div></div>
          <div><div class="text-gray-500">Scheduled</div><div class="font-semibold">${fmt(totals.scheduled || m.scheduled)}</div></div>
          <div><div class="text-gray-500">Screened</div><div class="font-semibold">${fmt(totals.screened || m.screened)}</div></div>
          <div><div class="text-gray-500">Enrolled</div><div class="font-semibold">${fmt(totals.enrolled || m.enrolled)}</div></div>
          <div><div class="text-gray-500">Enroll / Screen</div><div class="font-semibold">${rate(totals.enrolled || m.enrolled, totals.screened || m.screened)}</div></div>
          <div><div class="text-gray-500">Sites</div><div class="font-semibold">${totals.sites.size || m.nSites || '—'}</div></div>
        </div>

        <div>
          <h4 class="font-semibold text-gray-900 dark:text-white mb-2">By site (rolled up)</h4>
          ${siteRollupTableHtml(outcomes)}
        </div>

        <div>
          <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Every site × group row</h4>
          ${siteOutcomesTableHtml(outcomes)}
        </div>
      </div>`;

    document.getElementById('legacy-back-list')?.addEventListener('click', () => {
      detail.classList.add('hidden');
      detail.innerHTML = '';
      tableWrap?.classList.remove('hidden');
      summary?.classList.remove('hidden');
      state.selectedStudyId = null;
      renderStudiesTable(document.getElementById('legacy-study-search')?.value || '');
    });

    document.getElementById('legacy-save-meta')?.addEventListener('click', async () => {
      const payload = {
        therapeuticArea: document.getElementById('legacy-meta-ta').value.trim() || null,
        indication: document.getElementById('legacy-meta-indication').value.trim() || null,
        sponsor: document.getElementById('legacy-meta-sponsor').value.trim() || null,
        phase: document.getElementById('legacy-meta-phase').value.trim() || null,
        status: document.getElementById('legacy-meta-status').value.trim() || null,
        notes: document.getElementById('legacy-meta-notes').value.trim() || null,
      };
      try {
        const updated = await req(`/legacy-studies/${encodeURIComponent(studyId)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        const idx = state.studies.findIndex((s) => s.id === studyId);
        if (idx >= 0) state.studies[idx] = updated;
        if (global.showNotification) global.showNotification('Legacy study metadata saved', 'success');
        else alert('Saved');
      } catch (e) {
        console.error(e);
        alert('Save failed: ' + e.message);
      }
    });
  }

  let charts = { studies: null, funnel: null };

  function destroyCharts() {
    if (charts.studies) {
      charts.studies.destroy();
      charts.studies = null;
    }
    if (charts.funnel) {
      charts.funnel.destroy();
      charts.funnel = null;
    }
  }

  function renderReporting() {
    const kpis = document.getElementById('legacy-report-kpis');
    const tables = document.getElementById('legacy-report-tables');
    const taSel = document.getElementById('legacy-report-ta');
    const studySel = document.getElementById('legacy-report-study');
    if (!kpis || !tables) return;

    // populate study dropdown once
    if (studySel && studySel.options.length <= 1) {
      [...state.studies]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name;
          studySel.appendChild(opt);
        });
    }

    const tas = [...new Set(state.studies.map((s) => s.therapeuticArea || 'Unspecified'))].sort();
    if (taSel && taSel.options.length <= 1) {
      tas.forEach((ta) => {
        if (ta === 'Unspecified') return;
        const opt = document.createElement('option');
        opt.value = ta;
        opt.textContent = ta;
        taSel.appendChild(opt);
      });
    }

    const taFilter = taSel?.value || '';
    const studyFilter = studySel?.value || '';
    let studies = state.studies.filter((s) => !taFilter || s.therapeuticArea === taFilter);
    if (studyFilter) studies = studies.filter((s) => s.id === studyFilter);
    const studyIds = new Set(studies.map((s) => s.id));
    const outcomes = state.outcomes.filter((o) => studyIds.has(o.studyId)).map(normOutcome);

    const totals = sumOutcomes(outcomes);

    kpis.innerHTML = [
      ['Studies', studies.length],
      ['Site rows', outcomes.length],
      ['Scheduled', fmt(totals.scheduled)],
      ['Screened', fmt(totals.screened)],
      ['Enrolled', fmt(totals.enrolled)],
      ['E/S', rate(totals.enrolled, totals.screened)],
    ]
      .map(
        ([label, val]) => `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <div class="text-xs text-gray-500">${label}</div>
        <div class="text-lg font-semibold">${val}</div>
      </div>`
      )
      .join('');

    destroyCharts();
    if (global.Chart) {
      const top = [...studies]
        .sort((a, b) => num(b.metrics?.enrolled) - num(a.metrics?.enrolled))
        .slice(0, 12);
      const ctx1 = document.getElementById('legacy-chart-studies');
      if (ctx1) {
        charts.studies = new global.Chart(ctx1, {
          type: 'bar',
          data: {
            labels: top.map((s) => s.name),
            datasets: [{ label: 'Enrolled', data: top.map((s) => num(s.metrics?.enrolled)), backgroundColor: '#4f46e5' }],
          },
          options: { indexAxis: 'y', plugins: { legend: { display: false } }, responsive: true },
        });
      }
      const ctx2 = document.getElementById('legacy-chart-funnel');
      if (ctx2) {
        charts.funnel = new global.Chart(ctx2, {
          type: 'bar',
          data: {
            labels: ['Target Sched', 'Scheduled', 'Screened', 'Enrolled'],
            datasets: [
              {
                label: 'Count',
                data: [totals.targetScheduled, totals.scheduled, totals.screened, totals.enrolled],
                backgroundColor: ['#94a3b8', '#64748b', '#f59e0b', '#4f46e5'],
              },
            ],
          },
          options: { plugins: { legend: { display: false } }, responsive: true },
        });
      }
    }

    // Study → site sections
    const studyBlocks = studies
      .sort((a, b) => num(b.metrics?.enrolled) - num(a.metrics?.enrolled))
      .map((s) => {
        const rows = outcomes.filter((o) => o.studyId === s.id);
        const t = sumOutcomes(rows);
        return `
          <details class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800" ${studyFilter ? 'open' : ''}>
            <summary class="cursor-pointer px-3 py-2 font-semibold flex flex-wrap gap-x-4 gap-y-1 items-center">
              <span>${escapeHtml(s.name)}</span>
              <span class="text-xs font-normal text-gray-500">${rows.length} rows · ${t.sites.size} sites · enrolled ${fmt(t.enrolled)} · E/S ${rate(t.enrolled, t.screened)}</span>
            </summary>
            <div class="px-3 pb-3 space-y-3 border-t dark:border-gray-700">
              <div class="pt-2">
                <div class="text-sm font-medium mb-1">By site</div>
                ${siteRollupTableHtml(rows)}
              </div>
              <div>
                <div class="text-sm font-medium mb-1">Site × group detail (Visit 1 / LPLV / PI)</div>
                ${siteOutcomesTableHtml(rows)}
              </div>
            </div>
          </details>`;
      })
      .join('');

    tables.innerHTML = `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-x-auto">
        <div class="px-3 py-2 font-semibold border-b dark:border-gray-700">Study summary</div>
        <table class="min-w-full text-sm">
          <thead><tr class="text-left bg-gray-50 dark:bg-gray-900/40">
            <th class="px-3 py-2">Study</th><th class="px-3 py-2">TA</th>
            <th class="px-3 py-2 text-right">Sites</th>
            <th class="px-3 py-2 text-right">Target</th>
            <th class="px-3 py-2 text-right">Sched</th><th class="px-3 py-2 text-right">Screen</th>
            <th class="px-3 py-2 text-right">Enrolled</th><th class="px-3 py-2 text-right">E/S</th>
            <th class="px-3 py-2">Visit1</th><th class="px-3 py-2">LPLV</th>
          </tr></thead>
          <tbody>
            ${studies
              .map((s) => {
                const m = s.metrics || {};
                const rows = outcomes.filter((o) => o.studyId === s.id);
                return `<tr class="border-t dark:border-gray-700">
                  <td class="px-3 py-1.5 font-medium">${escapeHtml(s.name)}</td>
                  <td class="px-3 py-1.5">${escapeHtml(s.therapeuticArea || '—')}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.nSites ?? bySiteRollup(rows).length)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.targetScheduled)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.scheduled)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.screened)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.enrolled)}</td>
                  <td class="px-3 py-1.5 text-right">${rate(m.enrolled, m.screened)}</td>
                  <td class="px-3 py-1.5 text-xs">${escapeHtml([m.visit1StartMin, m.visit1StartMax].filter(Boolean).join(' → ') || '—')}</td>
                  <td class="px-3 py-1.5 text-xs">${escapeHtml([m.lplvMin, m.lplvMax].filter(Boolean).join(' → ') || '—')}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="space-y-2">
        <h3 class="font-semibold text-gray-900 dark:text-white">Breakdown by study → site</h3>
        ${studyBlocks || '<p class="text-sm text-gray-500">No studies in filter.</p>'}
      </div>`;
  }

  function exportCsv() {
    const headers = [
      'studyName',
      'siteName',
      'group',
      'pi',
      'visit1Start',
      'lplv',
      'targetScheduled',
      'scheduled',
      'screened',
      'enrolled',
    ];
    const lines = [headers.join(',')];
    for (const raw of state.outcomes) {
      const o = normOutcome(raw);
      lines.push(
        headers
          .map((h) => {
            const v = o[h] ?? '';
            const t = String(v).replace(/"/g, '""');
            return `"${t}"`;
          })
          .join(',')
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `legacy-study-site-outcomes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  async function mountStudies() {
    await ensureLoaded();
    renderStudiesTable();
    document.getElementById('legacy-study-search')?.addEventListener('input', (e) => {
      renderStudiesTable(e.target.value);
    });
    document.getElementById('legacy-studies-refresh')?.addEventListener('click', async () => {
      state.loaded = false;
      await ensureLoaded(true);
      renderStudiesTable(document.getElementById('legacy-study-search')?.value || '');
    });
  }

  async function mountReporting() {
    await ensureLoaded();
    // reset selects so they repopulate
    const studySel = document.getElementById('legacy-report-study');
    const taSel = document.getElementById('legacy-report-ta');
    if (studySel) studySel.innerHTML = '<option value="">All studies (summary)</option>';
    if (taSel) taSel.innerHTML = '<option value="">All therapeutic areas</option>';
    renderReporting();
    studySel?.addEventListener('change', renderReporting);
    taSel?.addEventListener('change', renderReporting);
    document.getElementById('legacy-report-refresh')?.addEventListener('click', async () => {
      state.loaded = false;
      await ensureLoaded(true);
      if (studySel) studySel.innerHTML = '<option value="">All studies (summary)</option>';
      if (taSel) taSel.innerHTML = '<option value="">All therapeutic areas</option>';
      renderReporting();
    });
    document.getElementById('legacy-report-export')?.addEventListener('click', exportCsv);
  }

  function attachApiMethods() {
    if (!global.apiService) return;
    global.apiService.getLegacyStudies = () => global.apiService.request('/legacy-studies');
    global.apiService.updateLegacyStudy = (id, body) =>
      global.apiService.request(`/legacy-studies/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    global.apiService.getLegacyOutcomes = (studyId) =>
      global.apiService.request(
        studyId ? `/legacy-study-site-outcomes?studyId=${encodeURIComponent(studyId)}` : '/legacy-study-site-outcomes'
      );
  }

  global.ArtemisLegacy = {
    getLegacyStudiesHTML,
    getLegacyReportingHTML,
    mountStudies,
    mountReporting,
    ensureLoaded,
    attachApiMethods,
    state,
  };
})(window);
