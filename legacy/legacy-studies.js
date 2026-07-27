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
    reportFilter: { therapeuticArea: '', status: '', q: '' },
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
      req('/legacy-studies').catch(() => []),
      req('/legacy-study-site-outcomes').catch(() => []),
    ]);
    state.studies = Array.isArray(studies) ? studies : [];
    state.outcomes = Array.isArray(outcomes) ? outcomes : [];
    state.loaded = true;
    return state;
  }

  function fmt(n) {
    if (n == null || n === '') return '—';
    const x = Number(n);
    if (Number.isNaN(x)) return String(n);
    return x.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function rate(a, b) {
    if (a == null || b == null || !b) return '—';
    return `${((Number(a) / Number(b)) * 100).toFixed(1)}%`;
  }

  function getLegacyStudiesHTML() {
    return `
      <div class="space-y-4" id="legacy-studies-root">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Legacy Studies</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Site–study outcomes from Anterior Segment Overview. Not patient/subject data. Editable therapeutic area and metadata.
            </p>
          </div>
          <div class="flex gap-2">
            <input id="legacy-study-search" type="search" placeholder="Search studies…"
              class="px-3 py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-sm w-56" />
            <button id="legacy-studies-refresh" class="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Refresh</button>
          </div>
        </div>
        <div id="legacy-studies-summary" class="grid grid-cols-2 md:grid-cols-4 gap-3"></div>
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
              Standard suite over legacy site–study outcomes (funnel, by study, by site, by TA).
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <select id="legacy-report-ta" class="px-3 py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-sm">
              <option value="">All therapeutic areas</option>
            </select>
            <button id="legacy-report-refresh" class="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Refresh</button>
            <button id="legacy-report-export" class="px-3 py-2 text-sm rounded-md border dark:border-gray-600">Export CSV</button>
          </div>
        </div>
        <div id="legacy-report-kpis" class="grid grid-cols-2 md:grid-cols-5 gap-3"></div>
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
        a.enrolled += Number(x.enrolled) || 0;
        a.screened += Number(x.screened) || 0;
        a.scheduled += Number(x.scheduled) || 0;
        a.sites += Number(x.nSites) || 0;
        return a;
      },
      { enrolled: 0, screened: 0, scheduled: 0, sites: 0 }
    );
    el.innerHTML = [
      ['Studies', studies.length],
      ['Enrolled', fmt(m.enrolled)],
      ['Screened', fmt(m.screened)],
      ['Scheduled', fmt(m.scheduled)],
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
    if (!wrap) return;
    const qq = q.trim().toLowerCase();
    const rows = state.studies
      .filter((s) => {
        if (!qq) return true;
        const blob = `${s.name} ${s.title} ${s.therapeuticArea || ''} ${s.indication || ''}`.toLowerCase();
        return blob.includes(qq);
      })
      .sort((a, b) => (Number(b.metrics?.enrolled) || 0) - (Number(a.metrics?.enrolled) || 0));

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
              return `<tr class="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40">
                <td class="px-3 py-2 font-medium text-gray-900 dark:text-white">${escapeHtml(s.name || s.title)}</td>
                <td class="px-3 py-2">${escapeHtml(s.therapeuticArea || '—')}</td>
                <td class="px-3 py-2">${escapeHtml(s.indication || '—')}</td>
                <td class="px-3 py-2 text-right">${fmt(m.nSites)}</td>
                <td class="px-3 py-2 text-right">${fmt(m.scheduled)}</td>
                <td class="px-3 py-2 text-right">${fmt(m.screened)}</td>
                <td class="px-3 py-2 text-right font-semibold">${fmt(m.enrolled)}</td>
                <td class="px-3 py-2 text-right">${rate(m.enrolled, m.screened)}</td>
                <td class="px-3 py-2 text-xs text-gray-500">${escapeHtml(
                  [m.visit1StartMin, m.visit1StartMax].filter(Boolean).join(' → ') || '—'
                )}</td>
                <td class="px-3 py-2 text-right">
                  <button data-legacy-open="${s.id}" class="text-indigo-600 hover:underline">Open</button>
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

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function openStudyDetail(studyId) {
    state.selectedStudyId = studyId;
    const study = state.studies.find((s) => s.id === studyId);
    const detail = document.getElementById('legacy-study-detail');
    const tableWrap = document.getElementById('legacy-studies-table-wrap');
    if (!detail || !study) return;

    let outcomes = state.outcomes.filter((o) => o.studyId === studyId);
    if (!outcomes.length) {
      outcomes = await req(`/legacy-study-site-outcomes?studyId=${encodeURIComponent(studyId)}`).catch(() => []);
    }

    if (tableWrap) tableWrap.classList.add('hidden');
    detail.classList.remove('hidden');
    const m = study.metrics || {};
    detail.innerHTML = `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-4 space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <button id="legacy-back-list" class="text-sm text-indigo-600 hover:underline mb-1">← All legacy studies</button>
            <h3 class="text-xl font-bold text-gray-900 dark:text-white">${escapeHtml(study.name)}</h3>
            <p class="text-sm text-gray-500">LPLV ${escapeHtml(m.lplvMin || '—')} → ${escapeHtml(m.lplvMax || '—')}</p>
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
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div><div class="text-gray-500">Scheduled</div><div class="font-semibold">${fmt(m.scheduled)}</div></div>
          <div><div class="text-gray-500">Screened</div><div class="font-semibold">${fmt(m.screened)}</div></div>
          <div><div class="text-gray-500">Enrolled</div><div class="font-semibold">${fmt(m.enrolled)}</div></div>
          <div><div class="text-gray-500">Enroll / Screen</div><div class="font-semibold">${rate(m.enrolled, m.screened)}</div></div>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-900/50 text-left">
              <tr>
                <th class="px-2 py-2">Site</th>
                <th class="px-2 py-2">Group</th>
                <th class="px-2 py-2">PI</th>
                <th class="px-2 py-2">Visit 1</th>
                <th class="px-2 py-2">LPLV</th>
                <th class="px-2 py-2 text-right">Target Sched</th>
                <th class="px-2 py-2 text-right">Scheduled</th>
                <th class="px-2 py-2 text-right">Screened</th>
                <th class="px-2 py-2 text-right">Enrolled</th>
              </tr>
            </thead>
            <tbody>
              ${outcomes
                .sort((a, b) => (Number(b.enrolled) || 0) - (Number(a.enrolled) || 0))
                .map(
                  (o) => `<tr class="border-t dark:border-gray-700">
                  <td class="px-2 py-1.5">${escapeHtml(o.siteName)}</td>
                  <td class="px-2 py-1.5">${fmt(o.group)}</td>
                  <td class="px-2 py-1.5">${escapeHtml(o.pi || '—')}</td>
                  <td class="px-2 py-1.5">${escapeHtml(o.visit1Start || '—')}</td>
                  <td class="px-2 py-1.5">${escapeHtml(o.lplv || '—')}</td>
                  <td class="px-2 py-1.5 text-right">${fmt(o.targetScheduled)}</td>
                  <td class="px-2 py-1.5 text-right">${fmt(o.scheduled)}</td>
                  <td class="px-2 py-1.5 text-right">${fmt(o.screened)}</td>
                  <td class="px-2 py-1.5 text-right font-medium">${fmt(o.enrolled)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    document.getElementById('legacy-back-list')?.addEventListener('click', () => {
      detail.classList.add('hidden');
      detail.innerHTML = '';
      tableWrap?.classList.remove('hidden');
      state.selectedStudyId = null;
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
    if (!kpis || !tables) return;

    const tas = [...new Set(state.studies.map((s) => s.therapeuticArea || 'Unspecified'))].sort();
    if (taSel && taSel.options.length <= 1) {
      tas.forEach((ta) => {
        const opt = document.createElement('option');
        opt.value = ta === 'Unspecified' ? '' : ta;
        opt.textContent = ta;
        if (ta !== 'Unspecified') taSel.appendChild(opt);
      });
    }

    const taFilter = taSel?.value || '';
    const studies = state.studies.filter((s) => !taFilter || s.therapeuticArea === taFilter);
    const studyIds = new Set(studies.map((s) => s.id));
    const outcomes = state.outcomes.filter((o) => studyIds.has(o.studyId));

    const totals = outcomes.reduce(
      (a, o) => {
        a.targetScheduled += Number(o.targetScheduled) || 0;
        a.scheduled += Number(o.scheduled) || 0;
        a.screened += Number(o.screened) || 0;
        a.enrolled += Number(o.enrolled) || 0;
        return a;
      },
      { targetScheduled: 0, scheduled: 0, screened: 0, enrolled: 0 }
    );

    kpis.innerHTML = [
      ['Studies', studies.length],
      ['Site rows', outcomes.length],
      ['Scheduled', fmt(totals.scheduled)],
      ['Screened', fmt(totals.screened)],
      ['Enrolled', fmt(totals.enrolled)],
    ]
      .map(
        ([label, val]) => `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
        <div class="text-xs text-gray-500">${label}</div>
        <div class="text-lg font-semibold">${val}</div>
      </div>`
      )
      .join('');

    // Charts
    destroyCharts();
    if (global.Chart) {
      const top = [...studies]
        .sort((a, b) => (Number(b.metrics?.enrolled) || 0) - (Number(a.metrics?.enrolled) || 0))
        .slice(0, 12);
      const ctx1 = document.getElementById('legacy-chart-studies');
      if (ctx1) {
        charts.studies = new global.Chart(ctx1, {
          type: 'bar',
          data: {
            labels: top.map((s) => s.name),
            datasets: [{ label: 'Enrolled', data: top.map((s) => Number(s.metrics?.enrolled) || 0), backgroundColor: '#4f46e5' }],
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

    // By site rollup
    const bySite = {};
    for (const o of outcomes) {
      if (!bySite[o.siteName]) bySite[o.siteName] = { scheduled: 0, screened: 0, enrolled: 0, studies: new Set() };
      bySite[o.siteName].scheduled += Number(o.scheduled) || 0;
      bySite[o.siteName].screened += Number(o.screened) || 0;
      bySite[o.siteName].enrolled += Number(o.enrolled) || 0;
      bySite[o.siteName].studies.add(o.studyName);
    }
    const siteRows = Object.entries(bySite)
      .map(([site, v]) => ({ site, ...v, nStudies: v.studies.size }))
      .sort((a, b) => b.enrolled - a.enrolled)
      .slice(0, 25);

    tables.innerHTML = `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-x-auto">
        <div class="px-3 py-2 font-semibold border-b dark:border-gray-700">Studies</div>
        <table class="min-w-full text-sm">
          <thead><tr class="text-left bg-gray-50 dark:bg-gray-900/40">
            <th class="px-3 py-2">Study</th><th class="px-3 py-2">TA</th>
            <th class="px-3 py-2 text-right">Sched</th><th class="px-3 py-2 text-right">Screen</th>
            <th class="px-3 py-2 text-right">Enrolled</th><th class="px-3 py-2 text-right">E/S</th>
          </tr></thead>
          <tbody>
            ${studies
              .sort((a, b) => (Number(b.metrics?.enrolled) || 0) - (Number(a.metrics?.enrolled) || 0))
              .map((s) => {
                const m = s.metrics || {};
                return `<tr class="border-t dark:border-gray-700">
                  <td class="px-3 py-1.5">${escapeHtml(s.name)}</td>
                  <td class="px-3 py-1.5">${escapeHtml(s.therapeuticArea || '—')}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.scheduled)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.screened)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.enrolled)}</td>
                  <td class="px-3 py-1.5 text-right">${rate(m.enrolled, m.screened)}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-x-auto">
        <div class="px-3 py-2 font-semibold border-b dark:border-gray-700">Top sites (by enrolled)</div>
        <table class="min-w-full text-sm">
          <thead><tr class="text-left bg-gray-50 dark:bg-gray-900/40">
            <th class="px-3 py-2">Site</th><th class="px-3 py-2 text-right">Studies</th>
            <th class="px-3 py-2 text-right">Sched</th><th class="px-3 py-2 text-right">Screen</th>
            <th class="px-3 py-2 text-right">Enrolled</th>
          </tr></thead>
          <tbody>
            ${siteRows
              .map(
                (r) => `<tr class="border-t dark:border-gray-700">
              <td class="px-3 py-1.5">${escapeHtml(r.site)}</td>
              <td class="px-3 py-1.5 text-right">${r.nStudies}</td>
              <td class="px-3 py-1.5 text-right">${fmt(r.scheduled)}</td>
              <td class="px-3 py-1.5 text-right">${fmt(r.screened)}</td>
              <td class="px-3 py-1.5 text-right">${fmt(r.enrolled)}</td>
            </tr>`
              )
              .join('')}
          </tbody>
        </table>
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
    for (const o of state.outcomes) {
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
      await ensureLoaded(true);
      renderStudiesTable(document.getElementById('legacy-study-search')?.value || '');
    });
  }

  async function mountReporting() {
    await ensureLoaded();
    renderReporting();
    document.getElementById('legacy-report-ta')?.addEventListener('change', renderReporting);
    document.getElementById('legacy-report-refresh')?.addEventListener('click', async () => {
      await ensureLoaded(true);
      renderReporting();
    });
    document.getElementById('legacy-report-export')?.addEventListener('click', exportCsv);
  }

  // Patch apiService when available
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
