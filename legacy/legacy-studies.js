/**
 * ARTEMIS Legacy Studies + Legacy Reporting (site-study outcomes only).
 * Loaded only by ARTEMIS index.html — not CHAOS / NASA.
 */
(function (global) {
  const state = {
    studies: [],
    sites: [],
    outcomes: [],
    feasibilityResponses: [],
    feasibilityDefs: [],
    loaded: false,
    selectedStudyId: null,
    selectedSiteId: null,
    selectedSurveyId: null,
    reportMode: 'bySite', // bySite | byStudy — bySite is ~50 rows, not ~700
    studySort: 'name-asc',
    siteSort: 'name-asc',
    feasSort: 'responses-desc',
  };

  function apiBase() {
    return (global.apiService && global.apiService.baseUrl) || '/api';
  }

  async function req(path, options = {}) {
    const method = options.method || 'GET';
    let body = options.body;
    if (body != null && typeof body !== 'string') {
      body = JSON.stringify(body);
    }
    if (global.apiService && typeof global.apiService.request === 'function') {
      return global.apiService.request(path.startsWith('/') ? path : `/${path}`, {
        method,
        body,
      });
    }
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body,
    });
    if (!res.ok) throw new Error(await res.text());
    if (res.status === 204) return null;
    return res.json();
  }

  async function ensureLoaded(force = false) {
    if (state.loaded && !force) return state;
    const [studies, sites, outcomes, feasibilityResponses, feasibilityDefs] = await Promise.all([
      req('/legacy-studies').catch((e) => {
        console.error('legacy-studies load failed', e);
        return [];
      }),
      req('/legacy-sites').catch((e) => {
        console.error('legacy-sites load failed', e);
        return [];
      }),
      req('/legacy-study-site-outcomes').catch((e) => {
        console.error('legacy outcomes load failed', e);
        return [];
      }),
      req('/site-survey-responses').catch((e) => {
        console.error('feasibility responses load failed', e);
        return [];
      }),
      req('/site-survey-definitions').catch((e) => {
        console.error('feasibility defs load failed', e);
        return [];
      }),
    ]);
    state.studies = Array.isArray(studies) ? studies : [];
    state.sites = Array.isArray(sites) ? sites : [];
    state.outcomes = Array.isArray(outcomes) ? outcomes : [];
    state.feasibilityResponses = (Array.isArray(feasibilityResponses) ? feasibilityResponses : []).filter(
      (r) => r && !r._archived
    );
    state.feasibilityDefs = Array.isArray(feasibilityDefs) ? feasibilityDefs : [];
    state.loaded = true;
    if (global.ArtemisSurveyUI && typeof global.ArtemisSurveyUI.syncCache === 'function') {
      global.ArtemisSurveyUI.syncCache({
        definitions: state.feasibilityDefs,
        responses: state.feasibilityResponses,
      });
    }
    console.log(
      'Legacy loaded',
      state.studies.length,
      'studies,',
      state.sites.length,
      'unique sites,',
      state.outcomes.length,
      'outcome rows,',
      state.feasibilityResponses.length,
      'feasibility responses'
    );
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

  function normSiteName(s) {
    return String(s ?? '')
      .toLowerCase()
      .replace(/\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc)\b/gi, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /** artemisSiteId -> merged legacy stats for that live site */
  let artemisLegacyIndex = null;

  function mergeLegacyIntoIndex(artemisId, legacySite, matchVia) {
    if (!artemisId || !legacySite) return;
    const m = legacySite.metrics || {};
    const studyNames = Array.isArray(m.studyNames) ? m.studyNames : [];
    const existing = artemisLegacyIndex.get(artemisId);
    if (existing) {
      existing.nStudies += num(m.nStudies);
      existing.enrolled += num(m.enrolled);
      existing.screened += num(m.screened);
      existing.scheduled += num(m.scheduled);
      existing.targetScheduled += num(m.targetScheduled);
      for (const n of studyNames) {
        if (n && !existing.studyNames.includes(n)) existing.studyNames.push(n);
      }
      if (!existing.legacySiteIds.includes(legacySite.id)) {
        existing.legacySiteIds.push(legacySite.id);
      }
      if (!existing.matchVia.includes(matchVia)) existing.matchVia.push(matchVia);
    } else {
      artemisLegacyIndex.set(artemisId, {
        legacySiteId: legacySite.id,
        legacySiteIds: [legacySite.id],
        legacyName: legacySite.name,
        nStudies: num(m.nStudies),
        enrolled: num(m.enrolled),
        screened: num(m.screened),
        scheduled: num(m.scheduled),
        targetScheduled: num(m.targetScheduled),
        studyNames: [...studyNames],
        matchVia: [matchVia],
      });
    }
  }

  function rebuildArtemisLegacyIndex(artemisSites) {
    artemisLegacyIndex = new Map();
    const liveSites = Array.isArray(artemisSites) ? artemisSites : [];
    if (!state.sites.length || !liveSites.length) return artemisLegacyIndex;

    const artemisByNorm = new Map();
    for (const s of liveSites) {
      if (!s?.id || !s?.name) continue;
      const norm = normSiteName(s.name);
      if (norm && !artemisByNorm.has(norm)) artemisByNorm.set(norm, s.id);
    }

    for (const ls of state.sites) {
      if (ls.linkedArtemisSiteId) {
        mergeLegacyIntoIndex(ls.linkedArtemisSiteId, ls, 'linked');
        continue;
      }
      const norm = normSiteName(ls.name);
      const artemisId = artemisByNorm.get(norm);
      if (artemisId) mergeLegacyIntoIndex(artemisId, ls, 'name');
    }

    return artemisLegacyIndex;
  }

  function goArtemisTab(tabId, reportPanel) {
    if (typeof global.navigateToTab === 'function') {
      global.navigateToTab(tabId, reportPanel ? { reportPanel } : {});
      return;
    }
    const sel = reportPanel
      ? `[data-nav-tab="${tabId}"][data-report-panel="${reportPanel}"]`
      : `[data-nav-tab="${tabId}"]`;
    document.querySelector(sel)?.click();
  }

  function getLegacyForArtemisSite(siteId) {
    if (!siteId || !artemisLegacyIndex) return null;
    return artemisLegacyIndex.get(siteId) || null;
  }

  /** Load legacy-sites only (lightweight) for matching live ARTEMIS sites. */
  async function ensureLegacySitesForMatching(force = false) {
    if (state.sites.length && !force) return state.sites;
    const sites = await req('/legacy-sites').catch((e) => {
      console.error('legacy-sites (matching) load failed', e);
      return [];
    });
    state.sites = Array.isArray(sites) ? sites : [];
    return state.sites;
  }

  async function refreshArtemisLegacyIndex(artemisSites) {
    await ensureLegacySitesForMatching();
    return rebuildArtemisLegacyIndex(artemisSites);
  }

  function sortLegacyRows(rows, sortKey, nameFn, enrolledFn) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const nameOf = nameFn || ((r) => r.name || r.title || '');
    const enrollOf = enrolledFn || ((r) => num(r.metrics?.enrolled));
    const key = sortKey || 'name-asc';
    if (key === 'name-desc') {
      list.sort((a, b) => String(nameOf(b)).localeCompare(String(nameOf(a)), undefined, { sensitivity: 'base' }));
    } else if (key === 'enrolled') {
      list.sort((a, b) => enrollOf(b) - enrollOf(a) || String(nameOf(a)).localeCompare(String(nameOf(b)), undefined, { sensitivity: 'base' }));
    } else {
      // name-asc (default)
      list.sort((a, b) => String(nameOf(a)).localeCompare(String(nameOf(b)), undefined, { sensitivity: 'base' }));
    }
    return list;
  }

  function sortSelectHtml(id, current) {
    const opts = [
      ['name-asc', 'A → Z'],
      ['name-desc', 'Z → A'],
      ['enrolled', 'Most enrolled'],
    ];
    return `<select id="${id}" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-auto min-h-[44px]" aria-label="Sort">
      ${opts.map(([v, label]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${label}</option>`).join('')}
    </select>`;
  }

  /** Whole-number display for screened / scheduled / enrolled counts. */
  function fmt(n) {
    if (n == null || n === '') return '—';
    const x = Number(n);
    if (Number.isNaN(x)) return String(n);
    return Math.round(x).toLocaleString();
  }

  /** Rank this site's enrolled count among all sites for a study (1 = highest). */
  function enrollmentRankForStudy(studyId, siteId) {
    if (!studyId || !siteId) return '—';
    const bySite = new Map();
    for (const raw of state.outcomes || []) {
      const o = normOutcome(raw);
      if (o.studyId !== studyId || !o.siteId) continue;
      bySite.set(o.siteId, (bySite.get(o.siteId) || 0) + num(o.enrolled));
    }
    if (!bySite.size || !bySite.has(siteId)) return '—';
    const ranked = [...bySite.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const idx = ranked.findIndex(([id]) => id === siteId);
    return idx >= 0 ? String(idx + 1) : '—';
  }

  function sfRate(screened, enrolled) {
    const s = Number(screened);
    const e = Number(enrolled);
    if (!s || Number.isNaN(s) || Number.isNaN(e) || s <= 0) return '—';
    const fails = Math.max(0, s - e);
    return `${Math.min(100, Math.max(0, (fails / s) * 100)).toFixed(1)}%`;
  }

  /** Conversion rate as percentage. Funnel steps (E/S, S/Sched) cap at 100%. */
  function rate(a, b, { cap = true } = {}) {
    const x = Number(a);
    const y = Number(b);
    if (!y || Number.isNaN(x) || Number.isNaN(y) || y <= 0) return '—';
    let pct = (x / y) * 100;
    if (cap) pct = Math.min(100, Math.max(0, pct));
    return `${pct.toFixed(1)}%`;
  }

  /** Numeric funnel rate for charts (0–100). */
  function ratePct(a, b, { cap = true } = {}) {
    const x = Number(a);
    const y = Number(b);
    if (!y || Number.isNaN(x) || Number.isNaN(y) || y <= 0) return null;
    let pct = (x / y) * 100;
    if (cap) pct = Math.min(100, Math.max(0, pct));
    return pct;
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
      siteId: o.siteId || (o.siteName ? `legacy-site-${String(o.siteName).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}` : ''),
      siteName: o.siteName || o.site || '',
      group: o.group ?? o.groupNumber ?? o.Group ?? null,
      pi: o.pi || o.PI || '',
      visit1Start: o.visit1Start || o.visit1_start || o.Visit1Start || '',
      lplv: o.lplv || o.LPLV || '',
      targetScheduled: o.targetScheduled ?? o.target_scheduled ?? null,
      targetEnrolled: o.targetEnrolled ?? o.target_enrolled ?? o.enrollmentTarget ?? null,
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
        a.targetEnrolled += num(o.targetEnrolled);
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
        targetEnrolled: 0,
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
                <td class="px-2 py-1.5 text-right">${rate(o.scheduled, o.targetScheduled, { cap: false })}</td>
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
              <td class="px-2 py-2 text-right">${rate(totals.scheduled, totals.targetScheduled, { cap: false })}</td>
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
    const studyEnroll = sites.reduce((a, s) => a + s.enrolled, 0) || 1;
    const cards = sites
      .map(
        (s) => `<div class="rounded-lg border dark:border-gray-700 p-3">
        <div class="font-medium text-gray-900 dark:text-white">${escapeHtml(s.siteName)}</div>
        <div class="text-xs text-gray-500 mt-0.5">PI ${escapeHtml(s.piList || '—')} · Groups ${escapeHtml(s.groupList)}</div>
        <div class="grid grid-cols-3 gap-1.5 mt-2">
          ${metricChip('Sched', fmt(s.scheduled))}
          ${metricChip('Screen', fmt(s.screened))}
          ${metricChip('Enrolled', fmt(s.enrolled), true)}
        </div>
        <div class="text-xs text-gray-500 mt-2">E/S ${rate(s.enrolled, s.screened)} · ${rate(s.enrolled, studyEnroll)} of study</div>
      </div>`
      )
      .join('');
    return `
      <div class="md:hidden space-y-2">${cards}</div>
      <div class="hidden md:block overflow-x-auto">
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
            ${sites
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
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  function getLegacyStudiesHTML() {
    return `
      <div class="space-y-4 px-1 sm:px-0" id="legacy-studies-root">
        <div class="flex flex-col gap-3">
          <div>
            <h2 class="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Completed Studies</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Site–study outcomes from Anterior Segment Overview. Open a study for full site / PI / Visit1 / LPLV breakdown.
            </p>
          </div>
          <div class="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <select id="legacy-study-sort" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-auto min-h-[44px]" aria-label="Sort studies">
              <option value="name-asc" selected>A → Z</option>
              <option value="name-desc">Z → A</option>
              <option value="enrolled">Most enrolled</option>
            </select>
            <input id="legacy-study-search" type="search" placeholder="Search studies…"
              class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-64 min-h-[44px]" />
            <button id="legacy-studies-refresh" class="px-4 py-3 sm:py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 min-h-[44px] shrink-0">Refresh</button>
          </div>
        </div>
        <div id="legacy-studies-summary" class="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3"></div>
        <div id="legacy-load-status" class="text-xs text-gray-500"></div>
        <div id="legacy-studies-table-wrap" class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden"></div>
        <div id="legacy-study-detail" class="hidden"></div>
      </div>`;
  }

  function getLegacyReportingHTML() {
    return `
      <div class="space-y-4 px-1 sm:px-0" id="legacy-reporting-root">
        <div class="flex flex-col gap-3">
          <div>
            <h2 class="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">Historical funnel</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              <strong>By Site</strong> = one row per unique site, not ~700 study×site lines.
            </p>
          </div>
          <div class="flex flex-col gap-2">
            <div class="inline-flex rounded-md border dark:border-gray-600 overflow-hidden text-sm w-full sm:w-auto">
              <button type="button" id="legacy-mode-site" class="flex-1 sm:flex-none px-4 py-3 sm:py-2 bg-indigo-600 text-white min-h-[44px]">By Site</button>
              <button type="button" id="legacy-mode-study" class="flex-1 sm:flex-none px-4 py-3 sm:py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 min-h-[44px]">By Study</button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap gap-2">
              <select id="legacy-report-study" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full lg:min-w-[12rem] min-h-[44px]">
                <option value="">All studies</option>
              </select>
              <select id="legacy-report-site" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full lg:min-w-[12rem] min-h-[44px]">
                <option value="">All sites</option>
              </select>
              <select id="legacy-report-indication" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full lg:min-w-[12rem] min-h-[44px]" aria-label="Indication / TA">
                <option value="">All indications / TA</option>
              </select>
              <button id="legacy-report-refresh" class="px-4 py-3 sm:py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 min-h-[44px]">Refresh</button>
              <button id="legacy-report-export" class="px-4 py-3 sm:py-2 text-sm rounded-md border dark:border-gray-600 min-h-[44px]">Export CSV</button>
            </div>
          </div>
        </div>
        <div id="legacy-report-kpis" class="grid grid-cols-2 md:grid-cols-6 gap-2 sm:gap-3"></div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
            <h3 id="legacy-chart-title" class="font-semibold mb-2 text-gray-900 dark:text-white">Enrolled by site</h3>
            <div class="relative h-56 sm:h-64"><canvas id="legacy-chart-studies"></canvas></div>
          </div>
          <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
            <h3 class="font-semibold mb-2 text-gray-900 dark:text-white">Funnel totals</h3>
            <div class="relative h-56 sm:h-64"><canvas id="legacy-chart-funnel"></canvas></div>
          </div>
        </div>
        <div id="legacy-report-tables" class="space-y-4"></div>
      </div>`;
  }

  function getLegacySitesHTML() {
    return `
      <div class="space-y-4 px-1 sm:px-0" id="legacy-sites-root">
        <div class="rounded-xl overflow-hidden border border-[#1B2A4A]/20 dark:border-[#1B2A4A]/60">
          <div class="bg-[#1B2A4A] px-4 py-3 sm:px-5 sm:py-4 text-white">
            <h2 class="text-xl sm:text-2xl font-bold tracking-tight">Master Site List</h2>
            <p class="text-sm text-white/75 mt-1 max-w-3xl">
              Historical funnel + feasibility. Promote links (or creates) a live Site — Chaos schedules and NASA sync stay untouched.
            </p>
          </div>
          <div class="bg-[#F5F7FA] dark:bg-gray-900/40 px-3 py-3 sm:px-4 sticky top-0 z-10 border-b dark:border-gray-700 flex flex-col gap-2">
            <div class="flex flex-col sm:flex-row sm:flex-wrap gap-2 w-full">
              <select id="legacy-site-sort" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-auto min-h-[44px]" aria-label="Sort sites">
                <option value="name-asc" selected>A → Z</option>
                <option value="name-desc">Z → A</option>
                <option value="enrolled">Most enrolled</option>
              </select>
              <select id="legacy-site-pref-filter" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-auto min-h-[44px]" aria-label="Filter by site status">
                <option value="">All site statuses</option>
                <option value="prefer">Prefer</option>
                <option value="neutral">Neutral</option>
                <option value="cautious">Cautious</option>
                <option value="avoid">Avoid</option>
                <option value="unset">Not set</option>
              </select>
              <select id="legacy-site-indication-filter" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-auto min-h-[44px]" aria-label="Filter by indication / TA">
                <option value="">All indications / TA</option>
              </select>
              <input id="legacy-site-search" type="search" placeholder="Search sites…"
                class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:flex-1 sm:min-w-[12rem] min-h-[44px]" />
              <button id="legacy-sites-refresh" class="px-4 py-3 sm:py-2 text-sm rounded-md bg-[#0F6E56] text-white hover:bg-[#0c5a46] min-h-[44px] shrink-0">Refresh</button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" id="legacy-promote-selected" class="px-3 py-2 text-sm rounded-md bg-[#1B2A4A] text-white hover:bg-[#152238] min-h-[40px] disabled:opacity-40" disabled>Promote selected</button>
              <button type="button" id="legacy-promote-all" class="px-3 py-2 text-sm rounded-md border border-[#1B2A4A] text-[#1B2A4A] dark:text-white dark:border-gray-500 hover:bg-white dark:hover:bg-gray-800 min-h-[40px]">Promote all (preview)</button>
              <span id="legacy-promote-count" class="text-xs text-gray-600 dark:text-gray-400">0 selected</span>
              <span class="text-[11px] text-gray-500 dark:text-gray-400">Dry-run first · link matches only · new sites are inert stubs</span>
            </div>
          </div>
        </div>
        <div id="legacy-sites-summary" class="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3"></div>
        <div id="legacy-sites-load-status" class="text-xs text-gray-500"></div>
        <div id="legacy-sites-table-wrap" class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden"></div>
        <div id="legacy-site-detail" class="hidden"></div>
        <div id="legacy-promote-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"></div>
      </div>`;
  }

  function getLegacyFeasibilityHTML() {
    return `
      <div class="space-y-4 px-1 sm:px-0" id="legacy-feasibility-root">
        <div class="flex flex-col gap-3">
          <div class="rounded-xl bg-[#1B2A4A] px-4 py-3 sm:px-5 text-white">
            <h2 class="text-xl sm:text-2xl font-bold tracking-tight">Feasibility surveys</h2>
            <p class="text-sm text-white/75 mt-1">
              Browse by survey — site responses stay on legacy ids (not shared with Chaos).
            </p>
          </div>
          <div class="flex flex-col sm:flex-row sm:flex-wrap gap-2 w-full sticky top-0 z-10 bg-[#F5F7FA]/95 dark:bg-gray-900/90 py-2">
            <select id="legacy-feas-sort" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-auto min-h-[44px]" aria-label="Sort surveys">
              <option value="responses-desc" selected>Most responses</option>
              <option value="responses-asc">Fewest responses</option>
              <option value="name-asc">A → Z</option>
              <option value="name-desc">Z → A</option>
            </select>
            <select id="legacy-feas-indication-filter" class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:w-auto min-h-[44px]" aria-label="Filter by indication / TA">
              <option value="">All indications / TA</option>
            </select>
            <input id="legacy-feas-search" type="search" placeholder="Search surveys…"
              class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-800 dark:border-gray-600 text-base sm:text-sm w-full sm:flex-1 sm:min-w-[12rem] min-h-[44px]" />
            <button id="legacy-feas-refresh" class="px-4 py-3 sm:py-2 text-sm rounded-md bg-[#0F6E56] text-white hover:bg-[#0c5a46] min-h-[44px] shrink-0">Refresh</button>
          </div>
        </div>
        <div id="legacy-feas-summary" class="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3"></div>
        <div id="legacy-feas-load-status" class="text-xs text-gray-500"></div>
        <div id="legacy-feas-table-wrap" class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden"></div>
        <div id="legacy-feas-detail" class="hidden"></div>
      </div>`;
  }

  function metricChip(label, value, emphasize = false) {
    return `<div class="rounded-md bg-gray-50 dark:bg-gray-900/50 px-2 py-1.5 text-center min-w-0">
      <div class="text-[10px] sm:text-xs text-gray-500 truncate">${label}</div>
      <div class="text-sm font-semibold ${emphasize ? 'text-indigo-600 dark:text-indigo-300' : 'text-gray-900 dark:text-white'} truncate">${value}</div>
    </div>`;
  }

  const TAP_BTN =
    'inline-flex items-center justify-center px-4 py-2.5 min-h-[44px] text-sm font-medium rounded-md bg-[#0F6E56] text-white hover:bg-[#0c5a46]';
  const TAP_LINK =
    'inline-flex items-center justify-center px-3 py-2.5 min-h-[44px] text-sm font-medium text-[#0F6E56] dark:text-emerald-300';
  const TAP_BACK =
    'inline-flex items-center px-3 py-2.5 min-h-[44px] text-sm font-medium text-[#0F6E56] dark:text-emerald-300 -ml-2';

  const promoteSelected = new Set();

  function updatePromoteToolbar() {
    const countEl = document.getElementById('legacy-promote-count');
    const btn = document.getElementById('legacy-promote-selected');
    const n = promoteSelected.size;
    if (countEl) countEl.textContent = `${n} selected`;
    if (btn) btn.disabled = n === 0;
  }

  function liveLinkBadge(site) {
    if (!site?.linkedArtemisSiteId) {
      return `<span class="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">Unlinked</span>`;
    }
    const status = site.promoteStatus === 'created' ? 'Created live' : 'Linked';
    const name = site._liveSiteName || site.linkedArtemisSiteId;
    return `<span class="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200" title="${escapeHtml(site.linkedArtemisSiteId)}">${escapeHtml(status)} → ${escapeHtml(name)}</span>`;
  }

  async function runPromote({ legacySiteIds, dryRun }) {
    const body = { dryRun: !!dryRun };
    if (Array.isArray(legacySiteIds) && legacySiteIds.length) body.legacySiteIds = legacySiteIds;
    return req('/legacy-sites/promote', { method: 'POST', body });
  }

  function closePromoteModal() {
    const modal = document.getElementById('legacy-promote-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.innerHTML = '';
  }

  function renderPromotePreview(payload, { scopeLabel, ids }) {
    const modal = document.getElementById('legacy-promote-modal');
    if (!modal) return;
    const results = payload?.results || [];
    const s = payload?.summary || {};
    const rows = results
      .slice(0, 200)
      .map((r) => {
        const action = r.action || '';
        const tone =
          action === 'linked'
            ? 'text-teal-700'
            : action === 'created'
              ? 'text-indigo-700'
              : action === 'ambiguous'
                ? 'text-amber-700'
                : action === 'error'
                  ? 'text-rose-700'
                  : 'text-gray-600';
        return `<tr class="border-t dark:border-gray-700">
          <td class="px-2 py-1.5 text-sm">${escapeHtml(r.legacyName || r.legacySiteId)}</td>
          <td class="px-2 py-1.5 text-sm font-medium ${tone}">${escapeHtml(action)}</td>
          <td class="px-2 py-1.5 text-sm">${escapeHtml(r.liveSiteName || r.liveSiteId || '—')}</td>
          <td class="px-2 py-1.5 text-xs text-gray-500">${escapeHtml(r.reason || '')}</td>
        </tr>`;
      })
      .join('');
    modal.classList.remove('hidden');
    modal.innerHTML = `
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col" role="dialog" aria-modal="true">
        <div class="px-4 py-3 bg-[#1B2A4A] text-white">
          <h3 class="font-semibold text-lg">Promote preview — ${escapeHtml(scopeLabel)}</h3>
          <p class="text-xs text-white/70 mt-1">Chaos/NASA safe: link metadata only on matches; new live sites have no study membership or schedules.</p>
        </div>
        <div class="p-4 space-y-3 overflow-y-auto flex-1">
          <div class="flex flex-wrap gap-2 text-xs">
            <span class="px-2 py-1 rounded bg-teal-50 text-teal-800">Link ${s.linked || 0}</span>
            <span class="px-2 py-1 rounded bg-indigo-50 text-indigo-800">Create ${s.created || 0}</span>
            <span class="px-2 py-1 rounded bg-gray-100 text-gray-700">Skip ${s.skipped || 0}</span>
            <span class="px-2 py-1 rounded bg-amber-50 text-amber-800">Ambiguous ${s.ambiguous || 0}</span>
            <span class="px-2 py-1 rounded bg-rose-50 text-rose-800">Error ${s.error || 0}</span>
          </div>
          <div class="overflow-x-auto rounded border dark:border-gray-700 max-h-64">
            <table class="min-w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-900/50 text-left sticky top-0"><tr>
                <th class="px-2 py-1.5">Legacy</th><th class="px-2 py-1.5">Action</th><th class="px-2 py-1.5">Live site</th><th class="px-2 py-1.5">Reason</th>
              </tr></thead>
              <tbody>${rows || '<tr><td class="p-3 text-gray-500" colspan="4">Nothing to promote.</td></tr>'}</tbody>
            </table>
          </div>
          ${(s.ambiguous || 0) > 0 ? '<p class="text-xs text-amber-700">Ambiguous name matches are skipped — link them manually from site detail.</p>' : ''}
        </div>
        <div class="px-4 py-3 border-t dark:border-gray-700 flex flex-wrap justify-end gap-2 bg-[#F5F7FA] dark:bg-gray-900/40">
          <button type="button" id="legacy-promote-cancel" class="px-4 py-2 text-sm rounded-md border dark:border-gray-600">Cancel</button>
          <button type="button" id="legacy-promote-confirm" class="px-4 py-2 text-sm rounded-md bg-[#0F6E56] text-white hover:bg-[#0c5a46]"
            ${(s.linked || 0) + (s.created || 0) === 0 ? 'disabled' : ''}>Confirm promote</button>
        </div>
      </div>`;
    modal.querySelector('#legacy-promote-cancel')?.addEventListener('click', closePromoteModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePromoteModal();
    });
    modal.querySelector('#legacy-promote-confirm')?.addEventListener('click', async () => {
      const confirmBtn = modal.querySelector('#legacy-promote-confirm');
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Promoting…';
      }
      try {
        const applied = await runPromote({ legacySiteIds: ids, dryRun: false });
        closePromoteModal();
        promoteSelected.clear();
        state.loaded = false;
        await ensureLoaded(true);
        const sum = applied?.summary || {};
        alert(
          `Promote complete.\nLinked: ${sum.linked || 0}\nCreated: ${sum.created || 0}\nSkipped: ${sum.skipped || 0}\nAmbiguous: ${sum.ambiguous || 0}\nErrors: ${sum.error || 0}`
        );
        document.getElementById('legacy-sites-refresh')?.click();
      } catch (err) {
        console.error(err);
        alert(`Promote failed: ${err.message || err}`);
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm promote';
        }
      }
    });
  }

  async function openPromoteWizard({ all = false } = {}) {
    const ids = all ? null : [...promoteSelected];
    if (!all && (!ids || !ids.length)) {
      alert('Select at least one legacy site.');
      return;
    }
    if (all) {
      const ok = confirm(
        'Preview promote for ALL legacy sites?\n\nMatched names link only (no Chaos field overwrite).\nUnmatched create inert live site stubs.\nAmbiguous matches stay manual.'
      );
      if (!ok) return;
    }
    try {
      const preview = await runPromote({ legacySiteIds: ids || undefined, dryRun: true });
      renderPromotePreview(preview, {
        scopeLabel: all ? 'all legacy sites' : `${ids.length} selected`,
        ids: ids || undefined,
      });
    } catch (err) {
      console.error(err);
      alert(`Promote preview failed: ${err.message || err}`);
    }
  }

  const RELATIONSHIP_OPTIONS = [
    { value: '', label: 'Not set' },
    { value: 'prefer', label: 'Prefer — good to work with' },
    { value: 'neutral', label: 'Neutral' },
    { value: 'cautious', label: 'Cautious — use carefully' },
    { value: 'avoid', label: 'Avoid — prefer not to use' },
  ];

  function preferenceBadge(pref) {
    const p = (pref || '').toLowerCase();
    const map = {
      prefer: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
      neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
      cautious: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
      avoid: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
    };
    const label = p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Not set';
    const cls = map[p] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
    return `<span class="inline-flex px-2 py-0.5 rounded text-xs font-medium ${cls}">${escapeHtml(label)}</span>`;
  }

  function indicationPills(inds) {
    if (!inds || !inds.length) return `<span class="text-xs text-gray-400">—</span>`;
    return inds
      .slice(0, 4)
      .map(
        (i) =>
          `<span class="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">${escapeHtml(i)}</span>`
      )
      .join(' ') + (inds.length > 4 ? ` <span class="text-[10px] text-gray-400">+${inds.length - 4}</span>` : '');
  }

  function feasibilityForSite(siteId) {
    return (state.feasibilityResponses || []).filter((r) => r && r.siteId === siteId);
  }

  function feasibilityTitle(r) {
    const def = (state.feasibilityDefs || []).find((d) => d.id === r.surveyId);
    return def?.title || r.study?.study_name || r.sourceTab || r.surveyId || 'Survey';
  }

  function siteSummaryCards(el, sites) {
    if (!el) return;
    const m = sites.reduce(
      (a, s) => {
        const x = s.metrics || {};
        a.enrolled += num(x.enrolled);
        a.screened += num(x.screened);
        a.scheduled += num(x.scheduled);
        a.prefer += (s.relationshipPreference || '') === 'prefer' ? 1 : 0;
        return a;
      },
      { enrolled: 0, screened: 0, scheduled: 0, prefer: 0 }
    );
    el.innerHTML = [
      ['Unique sites', sites.length],
      ['Scheduled', fmt(m.scheduled)],
      ['Screened', fmt(m.screened)],
      ['Enrolled', fmt(m.enrolled)],
      ['Prefer', m.prefer],
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

  function outcomesForSite(siteId) {
    return state.outcomes.map(normOutcome).filter((o) => o.siteId === siteId);
  }

  function siteIndications(site) {
    const fromSite = [
      ...(Array.isArray(site?.indicationsCovered) ? site.indicationsCovered : []),
      ...(Array.isArray(site?.therapeuticAreas) ? site.therapeuticAreas : []),
    ];
    const fromSurveys = (state.feasibilityResponses || [])
      .filter((r) => r && r.siteId === site.id)
      .map((r) => r.indication || r.therapeuticArea || (r.study && r.study.indication))
      .filter(Boolean);
    return [...new Set([...fromSite, ...fromSurveys].map((x) => String(x).trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
  }

  function allIndicationOptions() {
    const set = new Set();
    for (const s of uniqueSitesFromState()) {
      for (const i of siteIndications(s)) set.add(i);
    }
    for (const r of state.feasibilityResponses || []) {
      const i = r.indication || r.therapeuticArea || (r.study && r.study.indication);
      if (i) set.add(String(i).trim());
    }
    for (const d of state.feasibilityDefs || []) {
      const i = d.indication || d.therapeuticArea || (d.study && d.study.indication);
      if (i) set.add(String(i).trim());
    }
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }

  function populateIndicationFilter(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const current = sel.value || '';
    const opts = allIndicationOptions();
    sel.innerHTML =
      `<option value="">All indications / TA</option>` +
      opts.map((i) => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('');
    if (current && opts.includes(current)) sel.value = current;
  }

  function profileFieldHtml(label, value) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '';
    const display = Array.isArray(value) ? value.join(', ') : String(value);
    return `<div>
      <dt class="text-xs text-gray-500">${escapeHtml(label)}</dt>
      <dd class="text-sm text-gray-900 dark:text-gray-100 mt-0.5 whitespace-pre-wrap">${escapeHtml(display)}</dd>
    </div>`;
  }

  function renderSiteProfileHtml(profile) {
    if (!profile) {
      return `<div class="text-sm text-gray-500 py-6 text-center">No site profile document yet for this legacy site.</div>`;
    }
    const inds = profile.indicationsCovered || profile.therapeuticAreas || [];
    const inv = Array.isArray(profile.investigators) ? profile.investigators : [];
    const contacts = Array.isArray(profile.contacts) ? profile.contacts : [];
    const studies = Array.isArray(profile.study_responses) ? profile.study_responses : [];
    return `
      <div class="space-y-4">
        <div class="flex flex-wrap gap-1.5">
          ${(inds || []).map((i) => `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">${escapeHtml(i)}</span>`).join('') || '<span class="text-xs text-gray-500">No indications tagged</span>'}
        </div>
        <div class="rounded-lg border dark:border-gray-700 p-4">
          <h5 class="text-sm font-semibold mb-3">Site details</h5>
          <dl class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${profileFieldHtml('Institution', profile.institution_name)}
            ${profileFieldHtml('Site type', profile.site_type)}
            ${profileFieldHtml('Address', [profile.address_street, profile.address_city, profile.address_state, profile.address_zip].filter(Boolean).join(', ') || profile.address_raw)}
            ${profileFieldHtml('Phone', profile.phone)}
            ${profileFieldHtml('IRB type', profile.irb_type)}
            ${profileFieldHtml('FDA audit history', profile.fda_audit_history == null ? '' : profile.fda_audit_history ? 'Yes' : 'No')}
            ${profileFieldHtml('Profile confirmed', profile.profile_last_confirmed)}
          </dl>
        </div>
        ${inv.length ? `<div class="rounded-lg border dark:border-gray-700 p-4">
          <h5 class="text-sm font-semibold mb-3">Investigators</h5>
          <ul class="space-y-2 text-sm">${inv.map((p) => `<li><span class="font-medium">${escapeHtml(p.name || '—')}</span>${p.credentials ? ` · ${escapeHtml(p.credentials)}` : ''}${p.specialty ? ` · ${escapeHtml(p.specialty)}` : ''}${p.email ? `<div class="text-xs text-gray-500">${escapeHtml(p.email)}</div>` : ''}</li>`).join('')}</ul>
        </div>` : ''}
        ${contacts.length ? `<div class="rounded-lg border dark:border-gray-700 p-4">
          <h5 class="text-sm font-semibold mb-3">Contacts</h5>
          <ul class="space-y-2 text-sm">${contacts.map((c) => `<li><span class="font-medium">${escapeHtml(c.name || '—')}</span> <span class="text-xs text-gray-500">(${escapeHtml(c.role || 'contact')})</span>${c.email ? `<div class="text-xs text-gray-500">${escapeHtml(c.email)}</div>` : ''}</li>`).join('')}</ul>
        </div>` : ''}
        ${studies.length ? `<div class="rounded-lg border dark:border-gray-700 p-4">
          <h5 class="text-sm font-semibold mb-3">Feasibility surveys on profile (${studies.length})</h5>
          <ul class="space-y-1.5 text-sm">${studies.map((s) => `<li class="flex flex-wrap gap-2 items-baseline"><span class="font-medium">${escapeHtml((s.study && s.study.study_name) || s.sourceTab || s.surveyId || 'Survey')}</span>${s.indication || s.therapeuticArea ? `<span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">${escapeHtml(s.indication || s.therapeuticArea)}</span>` : ''}<span class="text-xs text-gray-500">${escapeHtml(s.sourcePlatform || '')} · ${s.fieldCount || 0} fields</span></li>`).join('')}</ul>
        </div>` : ''}
      </div>`;
  }

  function renderSitesTable(q = '', prefFilter = '', indicationFilter = '') {
    const wrap = document.getElementById('legacy-sites-table-wrap');
    const summary = document.getElementById('legacy-sites-summary');
    const status = document.getElementById('legacy-sites-load-status');
    if (!wrap) return;

    const sites = uniqueSitesFromState();
    if (status) {
      status.textContent = `Loaded ${sites.length} unique sites · ${state.outcomes.length} outcome rows · ${state.studies.length} studies`;
    }

    const qq = q.trim().toLowerCase();
    const pf = (prefFilter || '').toLowerCase();
    const indf = (indicationFilter || '').trim();
    const filtered = sites.filter((s) => {
      if (pf === 'unset') {
        if (s.relationshipPreference) return false;
      } else if (pf && (s.relationshipPreference || '') !== pf) {
        return false;
      }
      if (indf) {
        const inds = siteIndications(s);
        if (!inds.includes(indf)) return false;
      }
      if (!qq) return true;
      const blob = `${s.name} ${s.siteCode || ''} ${s.advantages || ''} ${s.disadvantages || ''} ${s.relationshipNotes || ''} ${(siteIndications(s) || []).join(' ')}`.toLowerCase();
      return blob.includes(qq);
    });
    const rows = sortLegacyRows(
      filtered,
      state.siteSort || document.getElementById('legacy-site-sort')?.value || 'name-asc',
      (s) => s.name || '',
      (s) => num(s.metrics?.enrolled)
    );

    siteSummaryCards(summary, sites);

    const visibleIds = rows.map((s) => s.id);
    const allVisibleSelected =
      visibleIds.length > 0 && visibleIds.every((id) => promoteSelected.has(id));

    const cardHtml = rows
      .map((s) => {
        const m = s.metrics || {};
        const siteOutcomes = outcomesForSite(s.id);
        const t = sumOutcomes(siteOutcomes);
        const enrolled = t.enrolled || num(m.enrolled);
        const screened = t.screened || num(m.screened);
        const scheduled = t.scheduled || num(m.scheduled);
        const nStudies = new Set(siteOutcomes.map((o) => o.studyId)).size || m.nStudies || 0;
        const checked = promoteSelected.has(s.id) ? 'checked' : '';
        return `<div class="flex items-start gap-2 p-4 border-b dark:border-gray-700 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700/40">
          <input type="checkbox" class="mt-1.5 shrink-0" data-legacy-promote-id="${escapeHtml(s.id)}" ${checked}
            aria-label="Select ${escapeHtml(s.name || s.id)} for promote" />
          <button type="button" data-legacy-open-site="${escapeHtml(s.id)}"
            class="min-w-0 flex-1 text-left active:bg-indigo-50 dark:active:bg-indigo-900/20 transition-colors rounded-md -m-1 p-1">
            <div class="flex items-start justify-between gap-2 mb-2">
              <div class="min-w-0">
                <div class="font-semibold text-gray-900 dark:text-white truncate flex flex-wrap items-center gap-1.5">
                  <span class="truncate">${escapeHtml(s.name)}</span>
                  ${liveLinkBadge(s)}
                </div>
                <div class="text-xs text-gray-500 font-mono truncate">${escapeHtml(s.siteCode || s.id)}</div>
              </div>
              ${preferenceBadge(s.relationshipPreference)}
            </div>
            <div class="grid grid-cols-4 gap-1.5 mb-3">
              ${metricChip('Studies', nStudies)}
              ${metricChip('Sched', fmt(scheduled))}
              ${metricChip('Screen', fmt(screened))}
              ${metricChip('Enrolled', fmt(enrolled), true)}
            </div>
            <div class="flex items-center justify-between text-xs text-gray-500">
              <span>E/S ${rate(enrolled, screened)} · S/Sched ${rate(screened, scheduled)}</span>
              <span class="text-indigo-600 dark:text-indigo-300 font-medium">Open →</span>
            </div>
          </button>
        </div>`;
      })
      .join('');

    const tableRows = rows
      .map((s) => {
        const m = s.metrics || {};
        const siteOutcomes = outcomesForSite(s.id);
        const t = sumOutcomes(siteOutcomes);
        const enrolled = t.enrolled || num(m.enrolled);
        const screened = t.screened || num(m.screened);
        const scheduled = t.scheduled || num(m.scheduled);
        const nStudies = new Set(siteOutcomes.map((o) => o.studyId)).size || m.nStudies || 0;
        const checked = promoteSelected.has(s.id) ? 'checked' : '';
        return `<tr class="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40">
          <td class="px-3 py-2">
            <input type="checkbox" data-legacy-promote-id="${escapeHtml(s.id)}" ${checked}
              aria-label="Select ${escapeHtml(s.name || s.id)} for promote" />
          </td>
          <td class="px-3 py-2 font-medium text-gray-900 dark:text-white">
            <div class="flex flex-wrap items-center gap-1.5">
              <span>${escapeHtml(s.name)}</span>
              ${liveLinkBadge(s)}
            </div>
          </td>
          <td class="px-3 py-2 text-xs font-mono text-gray-500">${escapeHtml(s.siteCode || '—')}</td>
          <td class="px-3 py-2">${preferenceBadge(s.relationshipPreference)}</td>
          <td class="px-3 py-2 text-right">${nStudies}</td>
          <td class="px-3 py-2 text-right">${fmt(scheduled)}</td>
          <td class="px-3 py-2 text-right">${fmt(screened)}</td>
          <td class="px-3 py-2 text-right font-semibold">${fmt(enrolled)}</td>
          <td class="px-3 py-2 text-right">${rate(enrolled, screened)}</td>
          <td class="px-3 py-2 text-right">${rate(screened, scheduled)}</td>
          <td class="px-3 py-2 text-right">
            <button type="button" data-legacy-open-site="${escapeHtml(s.id)}" class="${TAP_BTN}">Open</button>
          </td>
        </tr>`;
      })
      .join('');

    wrap.innerHTML = `
      <div class="md:hidden divide-y dark:divide-gray-700">${cardHtml || '<div class="p-4 text-sm text-gray-500">No sites match.</div>'}</div>
      <div class="hidden md:block overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-900/50 text-left">
            <tr>
              <th class="px-3 py-2 w-10">
                <input type="checkbox" id="legacy-promote-select-all" ${allVisibleSelected ? 'checked' : ''}
                  aria-label="Select all visible sites for promote" ${visibleIds.length ? '' : 'disabled'} />
              </th>
              <th class="px-3 py-2">Site</th>
              <th class="px-3 py-2">Code</th>
              <th class="px-3 py-2">Site Status</th>
              <th class="px-3 py-2 text-right">Studies</th>
              <th class="px-3 py-2 text-right">Sched</th>
              <th class="px-3 py-2 text-right">Screen</th>
              <th class="px-3 py-2 text-right">Enrolled</th>
              <th class="px-3 py-2 text-right">Enrollment %</th>
              <th class="px-3 py-2 text-right">Sched→Screen</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;

    wrap.querySelectorAll('[data-legacy-open-site]').forEach((btn) => {
      btn.addEventListener('click', () => openSiteDetail(btn.getAttribute('data-legacy-open-site')));
    });

    wrap.querySelectorAll('[data-legacy-promote-id]').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-legacy-promote-id');
        if (!id) return;
        if (cb.checked) promoteSelected.add(id);
        else promoteSelected.delete(id);
        const selectAll = wrap.querySelector('#legacy-promote-select-all');
        if (selectAll) {
          selectAll.checked =
            visibleIds.length > 0 && visibleIds.every((vid) => promoteSelected.has(vid));
        }
        updatePromoteToolbar();
      });
    });

    wrap.querySelector('#legacy-promote-select-all')?.addEventListener('change', (e) => {
      const on = !!e.target.checked;
      visibleIds.forEach((id) => {
        if (on) promoteSelected.add(id);
        else promoteSelected.delete(id);
      });
      wrap.querySelectorAll('[data-legacy-promote-id]').forEach((cb) => {
        cb.checked = on;
      });
      updatePromoteToolbar();
    });

    updatePromoteToolbar();
  }

  async function openSiteDetail(siteId) {
    state.selectedSiteId = siteId;
    const sites = uniqueSitesFromState();
    let site = sites.find((s) => s.id === siteId) || state.sites.find((s) => s.id === siteId);
    if (!site) {
      // try fetch single
      try {
        site = await req(`/legacy-sites/${encodeURIComponent(siteId)}`);
      } catch (_) {
        site = null;
      }
    }

    // Prefer opening inside Legacy Sites tab if present; else navigate there
    const detail = document.getElementById('legacy-site-detail');
    const tableWrap = document.getElementById('legacy-sites-table-wrap');
    const summary = document.getElementById('legacy-sites-summary');

    if (!detail) {
      // Switch to Legacy Sites tab via header button, then open
      global.__legacyPendingSiteId = siteId;
      goArtemisTab('legacy-sites');
      return;
    }
    if (!site) {
      detail.classList.remove('hidden');
      detail.innerHTML = `<div class="p-4 text-sm text-amber-700">Site not found: ${escapeHtml(siteId)}</div>`;
      return;
    }

    if (tableWrap) tableWrap.classList.add('hidden');
    if (summary) summary.classList.add('hidden');
    detail.classList.remove('hidden');

    const outcomes = outcomesForSite(site.id);
    const t = sumOutcomes(outcomes);
    const m = site.metrics || {};
    const pis = [...new Set(outcomes.map((o) => o.pi).filter(Boolean))];
    const studyIds = [...new Set(outcomes.map((o) => o.studyId).filter(Boolean))];

    // Per-study rollup under this site
    const byStudy = {};
    for (const o of outcomes) {
      if (!byStudy[o.studyId]) {
        byStudy[o.studyId] = { studyId: o.studyId, studyName: o.studyName, rows: [] };
      }
      byStudy[o.studyId].rows.push(o);
    }
    const studyParts = Object.values(byStudy)
      .map((st) => {
        const stTotals = sumOutcomes(st.rows);
        const meta = state.studies.find((x) => x.id === st.studyId);
        const groups = [...new Set(st.rows.map((r) => normOutcome(r).group).filter((g) => g != null && g !== ''))];
        return {
          ...st,
          t: stTotals,
          meta,
          groupList: groups.length ? groups.join(', ') : '—',
          enrollRank: enrollmentRankForStudy(st.studyId, site.id),
        };
      })
      .sort((a, b) => b.t.enrolled - a.t.enrolled);

    const pref = site.relationshipPreference || '';
    const prefOptions = RELATIONSHIP_OPTIONS.map(
      (o) => `<option value="${o.value}" ${pref === o.value ? 'selected' : ''}>${o.label}</option>`
    ).join('');

    const screenedVal = t.screened || m.screened;
    const enrolledVal = t.enrolled || m.enrolled;
    const scheduledVal = t.scheduled || m.scheduled;
    const targetEnrolledVal =
      t.targetEnrolled || m.targetEnrolled || m.targetEnrollment || null;
    const targetEnrolledDisplay =
      targetEnrolledVal != null && Number(targetEnrolledVal) > 0 ? fmt(targetEnrolledVal) : '—';
    const enrolledVsTarget =
      targetEnrolledVal != null && Number(targetEnrolledVal) > 0
        ? rate(enrolledVal, targetEnrolledVal, { cap: false })
        : '—';

    const inds = siteIndications(site);
    const surveyUi = global.ArtemisSurveyUI;
    if (surveyUi?.syncCache) {
      surveyUi.syncCache({
        definitions: state.feasibilityDefs,
        responses: state.feasibilityResponses,
      });
    }
    const latestSurveys = surveyUi?.latestSurveyResponsesBySurvey
      ? surveyUi.latestSurveyResponsesBySurvey(site.id)
      : (state.feasibilityResponses || []).filter((r) => r.siteId === site.id);
    const surveysHtml = surveyUi?.siteSurveySectionsHtml
      ? surveyUi.siteSurveySectionsHtml(site.id)
      : `<div class="text-sm text-gray-500">Survey UI not loaded.</div>`;

    const lastFeasAt = (latestSurveys || [])
      .map((r) => Date.parse(r.submittedAt || r.createdAt || ''))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a)[0];
    const feasStale =
      !latestSurveys?.length ||
      !Number.isFinite(lastFeasAt) ||
      Date.now() - lastFeasAt > 90 * 24 * 60 * 60 * 1000;
    const feasStaleBadge = feasStale
      ? `<span class="inline-flex items-center gap-1.5 rounded-md border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:text-amber-200">Feasibility outdated
          <button type="button" id="legacy-send-recurring-feas" class="text-indigo-700 dark:text-indigo-300 hover:underline font-semibold">Send recurring feasibility</button>
        </span>`
      : '';

    let profile = null;
    try {
      profile = await req(`/site-profiles/${encodeURIComponent(site.id)}`);
    } catch (_) {
      profile = null;
    }

    if (site.linkedArtemisSiteId && !site._liveSiteName) {
      try {
        const live = await req(`/sites/${encodeURIComponent(site.linkedArtemisSiteId)}`);
        if (live?.name) site._liveSiteName = live.name;
      } catch (_) {
        /* linked id still usable for jump */
      }
    }
    const liveLinked = !!site.linkedArtemisSiteId;
    const liveDisplayName = site._liveSiteName || site.linkedArtemisSiteId || '';
    const liveLinkPanel = liveLinked
      ? `<div class="mt-3 rounded-md border border-teal-200 dark:border-teal-800/60 bg-teal-50/60 dark:bg-teal-900/20 px-3 py-2.5">
            <div class="text-xs font-medium text-teal-900 dark:text-teal-200 mb-1">Live site link</div>
            <div class="flex flex-wrap items-center gap-2">
              ${liveLinkBadge(site)}
              <span class="text-sm text-gray-800 dark:text-gray-200">${escapeHtml(liveDisplayName)}</span>
              ${
                site._liveSiteName && site._liveSiteName !== site.linkedArtemisSiteId
                  ? `<span class="text-xs text-gray-500">${escapeHtml(site.linkedArtemisSiteId)}</span>`
                  : ''
              }
              <button type="button" id="legacy-jump-live-site" class="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline">Open live site →</button>
            </div>
          </div>`
      : `<div class="mt-3 rounded-md border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 px-3 py-2.5">
            <div class="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Live site link</div>
            <div class="flex flex-wrap items-center gap-2 mb-1">${liveLinkBadge(site)}</div>
            <p class="text-xs text-gray-500 dark:text-gray-400">Promote from the list links or creates a live site without touching Chaos schedules.</p>
          </div>`;

    detail.innerHTML = `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 space-y-5">
        <div class="flex flex-col gap-3">
          <div>
            <button type="button" id="legacy-back-sites" class="${TAP_BACK}">← Master Site List</button>
            <h3 class="text-xl font-bold text-gray-900 dark:text-white mt-1" id="legacy-site-heading">${escapeHtml(site.name)}</h3>
            <p class="text-sm text-gray-500 flex flex-wrap items-center gap-2 mt-1">
              <span class="font-mono text-xs font-semibold">${escapeHtml(site.siteCode || site.id)}</span>
              ${preferenceBadge(site.relationshipPreference)}
              ${feasStaleBadge}
              <span>· ${studyIds.length} completed studies · ${outcomes.length} rows · ${pis.length} PI(s) · ${latestSurveys.length} surveys</span>
            </p>
            <div class="flex flex-wrap gap-1.5 mt-2">
              ${inds.map((i) => `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">${escapeHtml(i)}</span>`).join('') || '<span class="text-xs text-gray-400">No indications / TA tagged</span>'}
            </div>
            ${liveLinkPanel}
          </div>
          <button type="button" id="legacy-save-site" class="${TAP_BTN} w-full sm:w-auto">Save site</button>
        </div>

        <div class="flex gap-1 border-b dark:border-gray-700 overflow-x-auto">
          <button type="button" class="legacy-site-tab px-3 py-2 text-sm font-medium border-b-2 border-indigo-600 text-indigo-700 dark:text-indigo-300" data-legacy-site-tab="overview">Overview</button>
          <button type="button" class="legacy-site-tab px-3 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500" data-legacy-site-tab="surveys">
            Surveys ${latestSurveys.length ? `<span class="ml-1 inline-flex min-w-[1.25rem] h-5 px-1 items-center justify-center rounded-full bg-indigo-600 text-white text-[10px] font-bold">${latestSurveys.length}</span>` : ''}
          </button>
          <button type="button" class="legacy-site-tab px-3 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500" data-legacy-site-tab="profile">Site profile</button>
        </div>

        <div data-legacy-site-panel="overview" class="space-y-5">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="text-sm sm:col-span-2">Site name
            <input id="legacy-site-name" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(site.name || '')}" required />
          </label>
          <label class="text-sm">Site code <span class="text-rose-600">*</span>
            <input id="legacy-site-code" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px] font-mono"
              value="${escapeHtml(site.siteCode || '')}" placeholder="Unique site identifier" required />
            <p class="text-xs text-gray-500 mt-1">Required unique identifier for this site.</p>
          </label>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          <div class="rounded border dark:border-gray-700 p-2.5"><div class="text-gray-500 text-xs">Screened</div><div class="font-semibold">${fmt(screenedVal)}</div></div>
          <div class="rounded border dark:border-gray-700 p-2.5"><div class="text-gray-500 text-xs">Enrolled</div><div class="font-semibold text-indigo-600 dark:text-indigo-300">${fmt(enrolledVal)}</div></div>
          <div class="rounded border dark:border-gray-700 p-2.5"><div class="text-gray-500 text-xs">Target Enrolled</div><div class="font-semibold">${targetEnrolledDisplay}</div></div>
          <div class="rounded border dark:border-gray-700 p-2.5"><div class="text-gray-500 text-xs">Enrolled Vs. Target</div><div class="font-semibold">${enrolledVsTarget}</div></div>
          <div class="rounded border dark:border-gray-700 p-2.5 sm:col-span-2"><div class="text-gray-500 text-xs">Scheduled to Screened Rate</div><div class="font-semibold">${rate(screenedVal, scheduledVal)}</div></div>
          <div class="rounded border dark:border-gray-700 p-2.5 sm:col-span-2"><div class="text-gray-500 text-xs">Enrollment %</div><div class="font-semibold">${rate(enrolledVal, screenedVal)}</div></div>
        </div>

        <div class="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-3 sm:p-4 space-y-3">
          <h4 class="font-semibold text-gray-900 dark:text-white">Site Status</h4>
          <p class="text-xs text-gray-500">Working preference for this site — preserved across re-ingest.</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label class="text-sm md:col-span-2">Site Status
              <select id="legacy-site-pref" class="mt-1 w-full px-3 py-3 sm:py-2 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]">
                ${prefOptions}
              </select>
            </label>
            <label class="text-sm">Advantages
              <textarea id="legacy-site-advantages" rows="4" placeholder="What works well here…"
                class="mt-1 w-full px-3 py-2 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm">${escapeHtml(site.advantages || '')}</textarea>
            </label>
            <label class="text-sm">Disadvantages
              <textarea id="legacy-site-disadvantages" rows="4" placeholder="Friction, risk, or watch-outs…"
                class="mt-1 w-full px-3 py-2 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm">${escapeHtml(site.disadvantages || '')}</textarea>
            </label>
            <label class="text-sm md:col-span-2">Site status notes
              <textarea id="legacy-site-rel-notes" rows="2" placeholder="Contacts, history, context…"
                class="mt-1 w-full px-3 py-2 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm">${escapeHtml(site.relationshipNotes || '')}</textarea>
            </label>
            <label class="text-sm md:col-span-2">General notes
              <textarea id="legacy-site-notes" rows="2"
                class="mt-1 w-full px-3 py-2 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm">${escapeHtml(site.notes || '')}</textarea>
            </label>
          </div>
        </div>

        <div>
          <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Completed Studies (${studyParts.length})</h4>
          <div class="md:hidden space-y-2">
            ${studyParts
              .map((st) => {
                const ta = st.meta?.therapeuticArea || st.meta?.indication || '—';
                const stPis = [...new Set(st.rows.map((r) => r.pi).filter(Boolean))].join(', ') || '—';
                return `<div class="rounded-lg border dark:border-gray-700 p-3">
                  <div class="font-medium text-gray-900 dark:text-white">${escapeHtml(st.studyName || st.studyId)}</div>
                  <div class="text-xs text-gray-500 mt-0.5">${escapeHtml(ta)} · PI ${escapeHtml(stPis)} · Groups ${escapeHtml(st.groupList)}</div>
                  <div class="grid grid-cols-3 gap-1.5 mt-2">
                    ${metricChip('Sched', fmt(st.t.scheduled))}
                    ${metricChip('Screen', fmt(st.t.screened))}
                    ${metricChip('Enrolled', fmt(st.t.enrolled), true)}
                  </div>
                  <div class="text-xs text-gray-500 mt-2">SF rate ${sfRate(st.t.screened, st.t.enrolled)} · Rank ${escapeHtml(st.enrollRank)}</div>
                </div>`;
              })
              .join('') || '<p class="text-sm text-gray-500">No completed studies.</p>'}
          </div>
          <div class="hidden md:block overflow-x-auto rounded border dark:border-gray-700">
            <table class="min-w-full text-sm">
              <thead class="bg-gray-50 dark:bg-gray-900/40 text-left">
                <tr>
                  <th class="px-3 py-2">Study Name</th>
                  <th class="px-3 py-2">Indication</th>
                  <th class="px-3 py-2">PI</th>
                  <th class="px-3 py-2">Groups</th>
                  <th class="px-3 py-2 text-right">Scheduled</th>
                  <th class="px-3 py-2 text-right">Screened</th>
                  <th class="px-3 py-2 text-right">Enrolled</th>
                  <th class="px-3 py-2 text-right">SF rate</th>
                  <th class="px-3 py-2 text-right">Enrollment Ranking</th>
                </tr>
              </thead>
              <tbody>
                ${studyParts
                  .map((st) => {
                    const ta = st.meta?.therapeuticArea || st.meta?.indication || '—';
                    const stPis = [...new Set(st.rows.map((r) => r.pi).filter(Boolean))].join(', ') || '—';
                    return `<tr class="border-t dark:border-gray-700">
                      <td class="px-3 py-1.5 font-medium">${escapeHtml(st.studyName || st.studyId)}</td>
                      <td class="px-3 py-1.5">${escapeHtml(ta)}</td>
                      <td class="px-3 py-1.5 text-xs">${escapeHtml(stPis)}</td>
                      <td class="px-3 py-1.5 text-xs">${escapeHtml(st.groupList)}</td>
                      <td class="px-3 py-1.5 text-right">${fmt(st.t.scheduled)}</td>
                      <td class="px-3 py-1.5 text-right">${fmt(st.t.screened)}</td>
                      <td class="px-3 py-1.5 text-right font-semibold">${fmt(st.t.enrolled)}</td>
                      <td class="px-3 py-1.5 text-right">${sfRate(st.t.screened, st.t.enrolled)}</td>
                      <td class="px-3 py-1.5 text-right">${escapeHtml(st.enrollRank)}</td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h4 class="font-semibold text-gray-900 dark:text-white mb-2">PIs seen here</h4>
          <p class="text-sm text-gray-700 dark:text-gray-300 break-words">${escapeHtml(pis.join(', ') || '—')}</p>
        </div>

        <div>
          <h4 class="font-semibold text-gray-900 dark:text-white mb-2">Every study × group row</h4>
          ${siteOutcomesTableHtml(outcomes, { showStudy: true })}
        </div>
        </div>

        <div data-legacy-site-panel="surveys" class="hidden space-y-4">
          <p class="text-xs text-gray-500">Same survey accordion as live Sites. Responses are keyed to this legacy site id (not shared Chaos sites).</p>
          ${surveysHtml}
        </div>

        <div data-legacy-site-panel="profile" class="hidden space-y-4">
          <p class="text-xs text-gray-500">Site profile master fields for Budget Buddy / feasibility — ARTEMIS-only container <code class="text-[10px]">site-profiles</code>.</p>
          ${renderSiteProfileHtml(profile)}
        </div>
      </div>`;

    const setLegacySiteTab = (tab) => {
      detail.querySelectorAll('[data-legacy-site-tab]').forEach((btn) => {
        const on = btn.getAttribute('data-legacy-site-tab') === tab;
        btn.classList.toggle('border-indigo-600', on);
        btn.classList.toggle('text-indigo-700', on);
        btn.classList.toggle('dark:text-indigo-300', on);
        btn.classList.toggle('border-transparent', !on);
        btn.classList.toggle('text-gray-500', !on);
      });
      detail.querySelectorAll('[data-legacy-site-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.getAttribute('data-legacy-site-panel') !== tab);
      });
    };
    detail.querySelectorAll('[data-legacy-site-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setLegacySiteTab(btn.getAttribute('data-legacy-site-tab')));
    });
    detail.querySelectorAll('.view-site-survey-response-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-response-id');
        const response = (state.feasibilityResponses || []).find((r) => r.id === id);
        if (response && surveyUi?.createSiteSurveyResponseModal) {
          surveyUi.createSiteSurveyResponseModal(response);
        }
      });
    });

    document.getElementById('legacy-jump-live-site')?.addEventListener('click', () => {
      if (!site.linkedArtemisSiteId) return;
      global.__pendingLiveSiteId = site.linkedArtemisSiteId;
      document.getElementById('sites-tab-btn')?.click();
    });

    document.getElementById('legacy-send-recurring-feas')?.addEventListener('click', () => {
      // Lightweight: jump to Feasibility send panel (assignment modal needs a live site id).
      document.querySelector('[data-nav-tab="feasibility"]')?.click();
      setTimeout(() => {
        document.getElementById('new-site-survey-assignment-btn')?.click();
      }, 80);
    });

    document.getElementById('legacy-back-sites')?.addEventListener('click', () => {
      detail.classList.add('hidden');
      detail.innerHTML = '';
      tableWrap?.classList.remove('hidden');
      summary?.classList.remove('hidden');
      state.selectedSiteId = null;
      renderSitesTable(
        document.getElementById('legacy-site-search')?.value || '',
        document.getElementById('legacy-site-pref-filter')?.value || '',
        document.getElementById('legacy-site-indication-filter')?.value || ''
      );
    });

    document.getElementById('legacy-save-site')?.addEventListener('click', async () => {
      const nameVal = document.getElementById('legacy-site-name')?.value.trim();
      if (!nameVal) {
        alert('Site name is required');
        return;
      }
      const codeVal = document.getElementById('legacy-site-code')?.value.trim();
      if (!codeVal) {
        alert('Site code is required as the unique identifier');
        return;
      }
      const payload = {
        name: nameVal,
        siteCode: codeVal,
        relationshipPreference: document.getElementById('legacy-site-pref').value || null,
        advantages: document.getElementById('legacy-site-advantages').value.trim() || null,
        disadvantages: document.getElementById('legacy-site-disadvantages').value.trim() || null,
        relationshipNotes: document.getElementById('legacy-site-rel-notes').value.trim() || null,
        notes: document.getElementById('legacy-site-notes').value.trim() || null,
      };
      try {
        const updated = await req(`/legacy-sites/${encodeURIComponent(site.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        const idx = state.sites.findIndex((s) => s.id === site.id);
        if (idx >= 0) state.sites[idx] = { ...state.sites[idx], ...updated };
        else state.sites.push(updated);
        artemisLegacyIndex = null; // force rematch after rename
        if (global.showNotification) global.showNotification('Legacy site saved', 'success');
        openSiteDetail(site.id);
      } catch (e) {
        alert('Save failed: ' + e.message);
      }
    });
  }

  function getLegacyDashboardHTML() {
    return `
      <section id="legacy-dashboard-root" class="border-t border-gray-200 dark:border-gray-700 pt-8 space-y-6">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h3 class="text-2xl font-bold text-gray-800 dark:text-gray-200">Completed Studies overview</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Anterior Segment historical site–study outcomes (Completed Projects funnel).
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" id="legacy-dash-refresh"
              class="px-3 py-2 text-sm rounded-md border dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">
              Refresh
            </button>
            <button type="button" id="legacy-dash-view-sites"
              class="px-3 py-2 text-sm rounded-md border dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700">
              Legacy Sites →
            </button>
            <button type="button" id="legacy-dash-view-all"
              class="px-3 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700">
              Full Legacy Reporting →
            </button>
          </div>
        </div>

        <div id="legacy-dash-status" class="text-xs text-gray-500 dark:text-gray-400">Loading legacy data…</div>

        <!-- Primary KPI strip -->
        <div id="legacy-dash-kpis" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3"></div>

        <!-- Conversion rate row -->
        <div id="legacy-dash-rates" class="grid grid-cols-2 sm:grid-cols-4 gap-3"></div>

        <!-- Row 1: top sites bar + funnel -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="lg:col-span-2 bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-4">Top sites by enrolled</h4>
            <div class="relative h-72">
              <canvas id="legacy-dash-chart-sites"></canvas>
            </div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-4">Enrollment funnel</h4>
            <div class="relative h-72">
              <canvas id="legacy-dash-chart-funnel"></canvas>
            </div>
          </div>
        </div>

        <!-- Row 2: TA doughnut + enrollment rate by site bar + site breakdown table -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-4">Studies by therapeutic area</h4>
            <div class="relative h-64">
              <canvas id="legacy-dash-chart-ta"></canvas>
            </div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-4">Screen → enroll rate by site (top 10)</h4>
            <div class="relative h-64">
              <canvas id="legacy-dash-chart-enroll-rate"></canvas>
            </div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-4">Studies per site distribution</h4>
            <div class="relative h-64">
              <canvas id="legacy-dash-chart-studies-per-site"></canvas>
            </div>
          </div>
        </div>

        <!-- Row 3: site productivity table (full width) -->
        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div class="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide">Site productivity (all sites)</h4>
            <span class="text-xs text-gray-400" id="legacy-dash-table-note"></span>
          </div>
          <div id="legacy-dash-table-wrap" class="overflow-x-auto max-h-80"></div>
        </div>

        <!-- Row 4: top study performers + low-enrollment tail -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700">
            <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-4">Top 10 studies by enrolled</h4>
            <div class="relative h-64">
              <canvas id="legacy-dash-chart-top-studies"></canvas>
            </div>
          </div>
          <div class="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <h4 class="text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide mb-3">Study summary</h4>
            <div id="legacy-dash-study-table" class="overflow-x-auto max-h-64"></div>
          </div>
        </div>
      </section>`;
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
      status.textContent = `Loaded ${state.studies.length} studies · ${state.sites.length || '—'} unique sites · ${state.outcomes.length} outcome rows (site×study lines)`;
    }
    const qq = q.trim().toLowerCase();
    const rows = sortLegacyRows(
      state.studies.filter((s) => {
        if (!qq) return true;
        const blob = `${s.name} ${s.title} ${s.oraProjectNumber || ''} ${s.therapeuticArea || ''} ${s.indication || ''}`.toLowerCase();
        return blob.includes(qq);
      }),
      state.studySort || document.getElementById('legacy-study-sort')?.value || 'name-asc',
      (s) => s.name || s.title || '',
      (s) => num(s.metrics?.enrolled)
    );

    if (summary) summaryCards(summary, state.studies);

    const cardHtml = rows
      .map((s) => {
        const m = s.metrics || {};
        const siteCount = m.nSites ?? state.outcomes.filter((o) => o.studyId === s.id).length;
        return `<button type="button" data-legacy-open="${escapeHtml(s.id)}"
          class="w-full text-left p-4 border-b dark:border-gray-700 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-indigo-50 dark:active:bg-indigo-900/20 transition-colors">
          <div class="flex items-start justify-between gap-2 mb-1">
            <div class="min-w-0">
              <div class="font-semibold text-gray-900 dark:text-white truncate">${escapeHtml(s.name || s.title)}</div>
              ${s.oraProjectNumber ? `<div class="text-[11px] font-mono text-indigo-600 dark:text-indigo-300 mt-0.5">${escapeHtml(s.oraProjectNumber)}</div>` : ''}
            </div>
            <span class="text-indigo-600 dark:text-indigo-300 text-sm font-medium shrink-0">Open →</span>
          </div>
          <div class="text-xs text-gray-500 mb-3 truncate">${escapeHtml(s.therapeuticArea || s.indication || 'No TA/indication')}</div>
          <div class="grid grid-cols-4 gap-1.5">
            ${metricChip('Sites', fmt(siteCount))}
            ${metricChip('Sched', fmt(m.scheduled))}
            ${metricChip('Screen', fmt(m.screened))}
            ${metricChip('Enrolled', fmt(m.enrolled), true)}
          </div>
          <div class="mt-2 text-xs text-gray-500">E/S ${rate(m.enrolled, m.screened)}</div>
        </button>`;
      })
      .join('');

    const tableRows = rows
      .map((s) => {
        const m = s.metrics || {};
        const siteCount = state.outcomes.filter((o) => o.studyId === s.id).length;
        return `<tr class="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40">
          <td class="px-3 py-2 font-medium text-gray-900 dark:text-white">${escapeHtml(s.name || s.title)}</td>
          <td class="px-3 py-2 font-mono text-xs">${escapeHtml(s.oraProjectNumber || '—')}</td>
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
            <button type="button" data-legacy-open="${escapeHtml(s.id)}" class="${TAP_BTN}">Open</button>
          </td>
        </tr>`;
      })
      .join('');

    wrap.innerHTML = `
      <div class="md:hidden divide-y dark:divide-gray-700">${cardHtml || '<div class="p-4 text-sm text-gray-500">No studies match.</div>'}</div>
      <div class="hidden md:block overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-900/50 text-left">
            <tr>
              <th class="px-3 py-2">Study</th>
              <th class="px-3 py-2">ORA #</th>
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
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;

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
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 space-y-4">
        <div class="flex flex-col gap-3">
          <div>
            <button type="button" id="legacy-back-list" class="${TAP_BACK}">← Completed Studies</button>
            <h3 class="text-xl font-bold text-gray-900 dark:text-white mt-1" id="legacy-study-heading">${escapeHtml(study.name || study.title)}</h3>
            <p class="text-sm text-gray-500">
              ${study.oraProjectNumber ? `ORA ${escapeHtml(study.oraProjectNumber)} · ` : ''}
              Visit 1 ${escapeHtml(m.visit1StartMin || totals.visitStarts.sort()[0] || '—')}
              → ${escapeHtml(m.visit1StartMax || totals.visitStarts.sort().slice(-1)[0] || '—')}
              · LPLV ${escapeHtml(m.lplvMin || '—')} → ${escapeHtml(m.lplvMax || '—')}
              · ${outcomes.length} site row(s)
            </p>
          </div>
          <button type="button" id="legacy-save-meta" class="${TAP_BTN} w-full sm:w-auto">Save metadata</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <label class="text-sm sm:col-span-2">Study name
            <input id="legacy-meta-name" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(study.name || study.title || '')}" required />
          </label>
          <label class="text-sm">ORA project number
            <input id="legacy-meta-ora" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(study.oraProjectNumber || '')}" placeholder="e.g. ORA-1234 or project #" />
          </label>
          <label class="text-sm">Therapeutic Area
            <input id="legacy-meta-ta" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(study.therapeuticArea || study.indication || '')}" placeholder="Same as Indication" />
          </label>
          <label class="text-sm">Indication
            <input id="legacy-meta-indication" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(study.indication || '')}" />
          </label>
          <label class="text-sm">Sponsor
            <input id="legacy-meta-sponsor" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(study.sponsor || '')}" />
          </label>
          <label class="text-sm">Phase
            <input id="legacy-meta-phase" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(study.phase || '')}" />
          </label>
          <label class="text-sm">Status
            <input id="legacy-meta-status" class="mt-1 w-full px-3 py-3 sm:py-1.5 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm min-h-[44px]"
              value="${escapeHtml(study.status || '')}" />
          </label>
          <label class="text-sm sm:col-span-2 md:col-span-3">Notes
            <textarea id="legacy-meta-notes" rows="2" class="mt-1 w-full px-3 py-2 border rounded dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm">${escapeHtml(
              study.notes || ''
            )}</textarea>
          </label>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 text-sm">
          ${metricChip('Target', fmt(totals.targetScheduled || m.targetScheduled))}
          ${metricChip('Scheduled', fmt(totals.scheduled || m.scheduled))}
          ${metricChip('Screened', fmt(totals.screened || m.screened))}
          ${metricChip('Enrolled', fmt(totals.enrolled || m.enrolled), true)}
          ${metricChip('E/S', rate(totals.enrolled || m.enrolled, totals.screened || m.screened))}
          ${metricChip('Sites', totals.sites.size || m.nSites || '—')}
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
      const nameVal = document.getElementById('legacy-meta-name').value.trim();
      if (!nameVal) {
        alert('Study name is required');
        return;
      }
      const payload = {
        name: nameVal,
        title: nameVal,
        oraProjectNumber: document.getElementById('legacy-meta-ora').value.trim() || null,
        therapeuticArea:
          document.getElementById('legacy-meta-ta').value.trim() ||
          document.getElementById('legacy-meta-indication').value.trim() ||
          null,
        indication: document.getElementById('legacy-meta-indication').value.trim() || null,
        sponsor: document.getElementById('legacy-meta-sponsor').value.trim() || null,
        phase: document.getElementById('legacy-meta-phase').value.trim() || null,
        status: document.getElementById('legacy-meta-status').value.trim() || null,
        notes: document.getElementById('legacy-meta-notes').value.trim() || null,
      };
      // Keep TA aligned with Indication when TA left blank
      if (!payload.therapeuticArea && payload.indication) payload.therapeuticArea = payload.indication;
      try {
        const updated = await req(`/legacy-studies/${encodeURIComponent(studyId)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        const idx = state.studies.findIndex((s) => s.id === studyId);
        if (idx >= 0) state.studies[idx] = updated;
        const heading = document.getElementById('legacy-study-heading');
        if (heading) heading.textContent = updated.name || updated.title || nameVal;
        if (global.showNotification) global.showNotification('Legacy study metadata saved', 'success');
        else alert('Saved');
      } catch (e) {
        console.error(e);
        alert('Save failed: ' + e.message);
      }
    });
  }

  let charts = { studies: null, funnel: null };
  let dashCharts = { sites: null, funnel: null, ta: null, enrollRate: null, studiesPerSite: null, topStudies: null };

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

  function destroyDashCharts() {
    Object.keys(dashCharts).forEach((k) => {
      if (dashCharts[k]) {
        dashCharts[k].destroy();
        dashCharts[k] = null;
      }
    });
  }

  function renderDashboard() {
    const kpis = document.getElementById('legacy-dash-kpis');
    const ratesEl = document.getElementById('legacy-dash-rates');
    const tableWrap = document.getElementById('legacy-dash-table-wrap');
    const tableNote = document.getElementById('legacy-dash-table-note');
    const studyTable = document.getElementById('legacy-dash-study-table');
    const status = document.getElementById('legacy-dash-status');
    if (!kpis) return;

    const outcomes = state.outcomes.map(normOutcome);
    const totals = sumOutcomes(outcomes);
    const sitesMaster = uniqueSitesFromState();

    // Build rich site rows with per-site aggregates
    const siteRows = sitesMaster
      .map((s) => {
        const rows = outcomes.filter((o) => o.siteId === s.id);
        const t = sumOutcomes(rows);
        const studyIds = [...new Set(rows.map((r) => r.studyId).filter(Boolean))];
        const piSet = new Set(rows.map((r) => r.pi).filter(Boolean));
        // Earliest visit1 / latest LPLV across all rows for this site
        const visits = rows.map((r) => r.visit1Start).filter(Boolean).sort();
        const lplvs = rows.map((r) => r.lplv).filter(Boolean).sort();
        const avgEnrollRate = ratePct(t.enrolled, t.screened);
        const schedRate = ratePct(t.scheduled, t.targetScheduled, { cap: false });
        return {
          site: s, rows, t, studyIds,
          piList: [...piSet].join(', '),
          nStudies: studyIds.length,
          nPIs: piSet.size,
          firstVisit: visits[0] || null,
          lastLplv: lplvs[lplvs.length - 1] || null,
          enrollRate: avgEnrollRate,
          schedRate,
        };
      })
      .filter((x) => x.rows.length > 0)
      .sort((a, b) => b.t.enrolled - a.t.enrolled);

    // Aggregate across all studies
    const totalSitesWithData = siteRows.length;
    const avgEnrolledPerSite = totalSitesWithData > 0
      ? (totals.enrolled / totalSitesWithData).toFixed(1)
      : '—';
    const medianEnrolled = (() => {
      const vals = siteRows.map((x) => x.t.enrolled).sort((a, b) => a - b);
      if (!vals.length) return '—';
      const mid = Math.floor(vals.length / 2);
      return vals.length % 2 === 0
        ? ((vals[mid - 1] + vals[mid]) / 2).toFixed(1)
        : String(vals[mid]);
    })();
    const topSiteShare = totals.enrolled > 0 && siteRows.length
      ? ((siteRows[0]?.t.enrolled / totals.enrolled) * 100).toFixed(1) + '%'
      : '—';
    const sitesAboveAvg = siteRows.filter(
      (x) => x.t.enrolled > num(avgEnrolledPerSite)
    ).length;

    if (status) {
      status.textContent = `${state.studies.length} studies · ${sitesMaster.length} unique sites · ${outcomes.length} outcome rows · data from Anterior Segment Overview`;
    }

    // KPI strip
    const kpiDef = (label, val, sub) => `
      <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 text-center">
        <div class="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">${label}</div>
        <div class="text-2xl font-bold text-gray-900 dark:text-white mt-0.5">${val}</div>
        ${sub ? `<div class="text-[11px] text-gray-400 mt-0.5">${sub}</div>` : ''}
      </div>`;

    kpis.innerHTML = [
      kpiDef('Unique sites', sitesMaster.length, `${totalSitesWithData} with data`),
      kpiDef('Studies', state.studies.length, ''),
      kpiDef('Scheduled', fmt(totals.scheduled), `Target: ${fmt(totals.targetScheduled)}`),
      kpiDef('Screened', fmt(totals.screened), rate(totals.screened, totals.scheduled) + ' of sched'),
      kpiDef('Enrolled', fmt(totals.enrolled), `Avg/site ${avgEnrolledPerSite}`),
      kpiDef('Screen→Enroll', rate(totals.enrolled, totals.screened), ''),
    ].join('');

    // Rates row
    if (ratesEl) {
      const rateDef = (label, val, color) => `
        <div class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 flex items-center gap-3">
          <div class="w-1 self-stretch rounded-full ${color}"></div>
          <div>
            <div class="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">${label}</div>
            <div class="text-xl font-bold text-gray-900 dark:text-white">${val}</div>
          </div>
        </div>`;
      ratesEl.innerHTML = [
        rateDef('Sched / Target', rate(totals.scheduled, totals.targetScheduled, { cap: false }), 'bg-slate-400'),
        rateDef('Median enrolled / site', medianEnrolled, 'bg-indigo-500'),
        rateDef('Sites above avg enrolled', sitesAboveAvg + ' / ' + totalSitesWithData, 'bg-emerald-500'),
        rateDef('Top site share', topSiteShare + ' of total enrolled', 'bg-amber-400'),
      ].join('');
    }

    destroyDashCharts();
    if (global.Chart) {
      const PALETTE = ['#4f46e5','#f59e0b','#10b981','#ef4444','#8b5cf6','#64748b','#ec4899','#0ea5e9','#f97316','#14b8a6','#a855f7','#6366f1'];

      // Chart 1: top sites by enrolled (horizontal bar)
      const topSites = siteRows.slice(0, 12);
      const ctxSites = document.getElementById('legacy-dash-chart-sites');
      if (ctxSites) {
        dashCharts.sites = new global.Chart(ctxSites, {
          type: 'bar',
          data: {
            labels: topSites.map((x) => x.site.name),
            datasets: [
              { label: 'Enrolled', data: topSites.map((x) => x.t.enrolled), backgroundColor: '#4f46e5' },
              { label: 'Screened', data: topSites.map((x) => x.t.screened), backgroundColor: '#a5b4fc' },
            ],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: true, position: 'top' } },
            scales: { x: { stacked: false } },
          },
        });
      }

      // Chart 2: funnel
      const ctxFunnel = document.getElementById('legacy-dash-chart-funnel');
      if (ctxFunnel) {
        dashCharts.funnel = new global.Chart(ctxFunnel, {
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
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  afterLabel: (ctx) => {
                    const vals = [totals.targetScheduled, totals.scheduled, totals.screened, totals.enrolled];
                    const prev = vals[ctx.dataIndex - 1];
                    if (prev == null || prev === 0) return '';
                    const stepPct = Math.min(100, Math.max(0, (ctx.parsed.y / prev) * 100));
                    return `${stepPct.toFixed(1)}% of prev step`;
                  },
                },
              },
            },
          },
        });
      }

      // Chart 3: studies by TA (doughnut)
      const taData = state.studies.reduce((acc, s) => {
        const ta = (s.therapeuticArea || s.indication || 'Unspecified').trim();
        acc[ta] = (acc[ta] || 0) + 1;
        return acc;
      }, {});
      const ctxTa = document.getElementById('legacy-dash-chart-ta');
      if (ctxTa) {
        dashCharts.ta = new global.Chart(ctxTa, {
          type: 'doughnut',
          data: {
            labels: Object.keys(taData),
            datasets: [{ data: Object.values(taData), backgroundColor: PALETTE }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
          },
        });
      }

      // Chart 4: screen→enroll rate by site (horizontal bar, top 10 with ≥5 screened)
      const ratedSites = siteRows
        .filter((x) => x.t.screened >= 5)
        .map((x) => ({ name: x.site.name, rate: ratePct(x.t.enrolled, x.t.screened) }))
        .filter((x) => x.rate != null)
        .sort((a, b) => b.rate - a.rate)
        .slice(0, 10);
      const ctxRate = document.getElementById('legacy-dash-chart-enroll-rate');
      if (ctxRate) {
        dashCharts.enrollRate = new global.Chart(ctxRate, {
          type: 'bar',
          data: {
            labels: ratedSites.map((x) => x.name),
            datasets: [{
              label: 'Enroll rate %',
              data: ratedSites.map((x) => parseFloat(x.rate.toFixed(1))),
              backgroundColor: ratedSites.map((x) =>
                x.rate >= 80 ? '#10b981' : x.rate >= 50 ? '#f59e0b' : '#ef4444'
              ),
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { max: 100, title: { display: true, text: '%' } } },
          },
        });
      }

      // Chart 5: studies per site distribution (histogram buckets)
      const studyCountBuckets = { '1': 0, '2': 0, '3-4': 0, '5-9': 0, '10+': 0 };
      siteRows.forEach(({ nStudies }) => {
        if (nStudies === 1) studyCountBuckets['1']++;
        else if (nStudies === 2) studyCountBuckets['2']++;
        else if (nStudies <= 4) studyCountBuckets['3-4']++;
        else if (nStudies <= 9) studyCountBuckets['5-9']++;
        else studyCountBuckets['10+']++;
      });
      const ctxSps = document.getElementById('legacy-dash-chart-studies-per-site');
      if (ctxSps) {
        dashCharts.studiesPerSite = new global.Chart(ctxSps, {
          type: 'bar',
          data: {
            labels: Object.keys(studyCountBuckets),
            datasets: [{
              label: 'Sites',
              data: Object.values(studyCountBuckets),
              backgroundColor: PALETTE,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => `${i[0].label} studies` } } },
            scales: { y: { title: { display: true, text: 'Sites' } } },
          },
        });
      }

      // Chart 6: top 10 studies by enrolled (horizontal bar)
      const topStudies = [...state.studies]
        .sort((a, b) => num(b.metrics?.enrolled) - num(a.metrics?.enrolled))
        .slice(0, 10);
      const ctxTopStudies = document.getElementById('legacy-dash-chart-top-studies');
      if (ctxTopStudies) {
        dashCharts.topStudies = new global.Chart(ctxTopStudies, {
          type: 'bar',
          data: {
            labels: topStudies.map((s) => s.name || s.title),
            datasets: [
              { label: 'Enrolled', data: topStudies.map((s) => num(s.metrics?.enrolled)), backgroundColor: '#4f46e5' },
              { label: 'Screened', data: topStudies.map((s) => num(s.metrics?.screened)), backgroundColor: '#a5b4fc' },
            ],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: true, position: 'top' } },
          },
        });
      }
    }

    // Site productivity table (all sites, scrollable)
    if (tableWrap) {
      if (tableNote) tableNote.textContent = `${siteRows.length} sites`;
      tableWrap.innerHTML = `
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-900/40 text-left sticky top-0">
            <tr>
              <th class="px-3 py-2 font-semibold">Site</th>
              <th class="px-3 py-2 font-semibold text-right">Studies</th>
              <th class="px-3 py-2 font-semibold text-right">PIs</th>
              <th class="px-3 py-2 font-semibold text-right">Target</th>
              <th class="px-3 py-2 font-semibold text-right">Sched</th>
              <th class="px-3 py-2 font-semibold text-right">Screened</th>
              <th class="px-3 py-2 font-semibold text-right">Enrolled</th>
              <th class="px-3 py-2 font-semibold text-right">Sched/Tgt</th>
              <th class="px-3 py-2 font-semibold text-right">E/S rate</th>
              <th class="px-3 py-2 font-semibold">First Visit1</th>
              <th class="px-3 py-2 font-semibold">Last LPLV</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            ${siteRows
              .map(({ site: s, t, nStudies, nPIs, enrollRate, schedRate, firstVisit, lastLplv }) => {
                const erColor = enrollRate == null ? '' : enrollRate >= 80 ? 'text-emerald-600 dark:text-emerald-400' : enrollRate >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400';
                return `<tr class="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td class="px-3 py-1.5 font-medium max-w-[180px] truncate">${escapeHtml(s.name)}</td>
                  <td class="px-3 py-1.5 text-right">${nStudies}</td>
                  <td class="px-3 py-1.5 text-right">${nPIs}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(t.targetScheduled)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(t.scheduled)}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(t.screened)}</td>
                  <td class="px-3 py-1.5 text-right font-semibold">${fmt(t.enrolled)}</td>
                  <td class="px-3 py-1.5 text-right">${schedRate != null ? schedRate.toFixed(1) + '%' : '—'}</td>
                  <td class="px-3 py-1.5 text-right font-semibold ${erColor}">${enrollRate != null ? enrollRate.toFixed(1) + '%' : '—'}</td>
                  <td class="px-3 py-1.5 text-xs whitespace-nowrap">${escapeHtml(firstVisit || '—')}</td>
                  <td class="px-3 py-1.5 text-xs whitespace-nowrap">${escapeHtml(lastLplv || '—')}</td>
                  <td class="px-3 py-1.5 text-right">
                    <button type="button" data-legacy-dash-site="${escapeHtml(s.id)}" class="text-indigo-600 hover:underline text-xs">Open</button>
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>`;
      tableWrap.querySelectorAll('[data-legacy-dash-site]').forEach((btn) => {
        btn.addEventListener('click', () => openSiteDetail(btn.getAttribute('data-legacy-dash-site')));
      });
    }

    // Study summary table
    if (studyTable) {
      const studiesSorted = [...state.studies].sort(
        (a, b) => num(b.metrics?.enrolled) - num(a.metrics?.enrolled)
      );
      studyTable.innerHTML = `
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-900/40 text-left sticky top-0">
            <tr>
              <th class="px-3 py-2 font-semibold">Study</th>
              <th class="px-3 py-2 font-semibold">TA</th>
              <th class="px-3 py-2 font-semibold text-right">Sites</th>
              <th class="px-3 py-2 font-semibold text-right">Screened</th>
              <th class="px-3 py-2 font-semibold text-right">Enrolled</th>
              <th class="px-3 py-2 font-semibold text-right">E/S</th>
            </tr>
          </thead>
          <tbody>
            ${studiesSorted.map((s) => {
              const m = s.metrics || {};
              const siteCount = new Set(outcomes.filter((o) => o.studyId === s.id).map((o) => o.siteId)).size;
              return `<tr class="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                <td class="px-3 py-1.5 font-medium max-w-[200px] truncate">${escapeHtml(s.name || s.title)}</td>
                <td class="px-3 py-1.5 text-xs">${escapeHtml(s.therapeuticArea || s.indication || '—')}</td>
                <td class="px-3 py-1.5 text-right">${siteCount || fmt(m.nSites)}</td>
                <td class="px-3 py-1.5 text-right">${fmt(m.screened)}</td>
                <td class="px-3 py-1.5 text-right font-semibold">${fmt(m.enrolled)}</td>
                <td class="px-3 py-1.5 text-right">${rate(m.enrolled, m.screened)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    }
  }

  async function mountDashboard() {
    const root = document.getElementById('legacy-dashboard-root');
    if (!root) return;

    const status = document.getElementById('legacy-dash-status');
    try {
      await ensureLoaded();
      renderDashboard();
    } catch (e) {
      console.error('Legacy dashboard load failed', e);
      if (status) status.textContent = 'Failed to load legacy data.';
    }

    document.getElementById('legacy-dash-refresh')?.addEventListener('click', async () => {
      state.loaded = false;
      await ensureLoaded(true);
      renderDashboard();
    });
    document.getElementById('legacy-dash-view-sites')?.addEventListener('click', () => {
      goArtemisTab('legacy-sites');
    });
    document.getElementById('legacy-dash-view-all')?.addEventListener('click', () => {
      goArtemisTab('reporting', 'history');
    });
  }

  function setReportMode(mode) {
    state.reportMode = mode === 'byStudy' ? 'byStudy' : 'bySite';
    const siteBtn = document.getElementById('legacy-mode-site');
    const studyBtn = document.getElementById('legacy-mode-study');
    if (siteBtn && studyBtn) {
      const on = 'flex-1 sm:flex-none px-4 py-3 sm:py-2 bg-indigo-600 text-white min-h-[44px]';
      const off =
        'flex-1 sm:flex-none px-4 py-3 sm:py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 min-h-[44px]';
      siteBtn.className = state.reportMode === 'bySite' ? on : off;
      studyBtn.className = state.reportMode === 'byStudy' ? on : off;
    }
    const title = document.getElementById('legacy-chart-title');
    if (title) title.textContent = state.reportMode === 'bySite' ? 'Enrolled by site' : 'Enrolled by study';
  }

  function uniqueSitesFromState() {
    // Prefer master legacy-sites (~50). Fallback: derive from outcomes by siteId.
    if (state.sites.length) return state.sites;
    const map = {};
    for (const raw of state.outcomes) {
      const o = normOutcome(raw);
      if (!o.siteId) continue;
      if (!map[o.siteId]) {
        map[o.siteId] = {
          id: o.siteId,
          name: o.siteName,
          siteCode: o.siteId.replace(/^legacy-site-/, '').toUpperCase().replace(/-/g, '_'),
          metrics: {
            enrolled: 0,
            screened: 0,
            scheduled: 0,
            targetScheduled: 0,
            nStudies: 0,
            nOutcomeRows: 0,
            studyNames: [],
          },
        };
      }
    }
    // fill metrics
    for (const raw of state.outcomes) {
      const o = normOutcome(raw);
      const s = map[o.siteId];
      if (!s) continue;
      s.metrics.enrolled += num(o.enrolled);
      s.metrics.screened += num(o.screened);
      s.metrics.scheduled += num(o.scheduled);
      s.metrics.targetScheduled += num(o.targetScheduled);
      s.metrics.nOutcomeRows += 1;
      if (o.studyName && !s.metrics.studyNames.includes(o.studyName)) s.metrics.studyNames.push(o.studyName);
    }
    Object.values(map).forEach((s) => {
      s.metrics.nStudies = s.metrics.studyNames.length;
    });
    return Object.values(map);
  }

  function renderReporting() {
    const kpis = document.getElementById('legacy-report-kpis');
    const tables = document.getElementById('legacy-report-tables');
    const studySel = document.getElementById('legacy-report-study');
    const siteSel = document.getElementById('legacy-report-site');
    const indSel = document.getElementById('legacy-report-indication');
    if (!kpis || !tables) return;

    populateIndicationFilter('legacy-report-indication');

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

    const sitesMaster = uniqueSitesFromState();
    if (siteSel && siteSel.options.length <= 1) {
      [...sitesMaster]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = `${s.name}${s.siteCode ? ` (${s.siteCode})` : ''}`;
          siteSel.appendChild(opt);
        });
    }

    const studyFilter = studySel?.value || '';
    const siteFilter = siteSel?.value || '';
    const indicationFilter = indSel?.value || '';
    let outcomes = state.outcomes.map(normOutcome);
    if (studyFilter) outcomes = outcomes.filter((o) => o.studyId === studyFilter);
    if (siteFilter) outcomes = outcomes.filter((o) => o.siteId === siteFilter);

    // When filtering by indication, prefer sites that have that feasibility TA
    let sitesForReport = sitesMaster;
    if (indicationFilter) {
      sitesForReport = sitesMaster.filter((s) => siteIndications(s).includes(indicationFilter));
      if (!siteFilter) {
        const allowed = new Set(sitesForReport.map((s) => s.id));
        outcomes = outcomes.filter((o) => allowed.has(o.siteId));
      }
    }

    const studyIds = new Set(outcomes.map((o) => o.studyId));
    const filteredStudies = studyFilter ? state.studies.filter((s) => s.id === studyFilter) : state.studies;
    const totals = sumOutcomes(outcomes);
    const uniqueSiteCount = new Set(outcomes.map((o) => o.siteId).filter(Boolean)).size;

    let feas = state.feasibilityResponses || [];
    if (siteFilter) feas = feas.filter((r) => r.siteId === siteFilter);
    if (indicationFilter) {
      feas = feas.filter((r) => {
        const i = r.indication || r.therapeuticArea || (r.study && r.study.indication);
        return i === indicationFilter;
      });
    }

    const feasByInd = {};
    for (const r of feas) {
      const i = r.indication || r.therapeuticArea || (r.study && r.study.indication) || 'Unknown';
      if (!feasByInd[i]) feasByInd[i] = { responses: 0, sites: new Set(), surveys: new Set() };
      feasByInd[i].responses += 1;
      if (r.siteId) feasByInd[i].sites.add(r.siteId);
      if (r.surveyId) feasByInd[i].surveys.add(r.surveyId);
    }
    const feasRows = Object.entries(feasByInd)
      .map(([indication, v]) => ({
        indication,
        responses: v.responses,
        sites: v.sites.size,
        surveys: v.surveys.size,
      }))
      .sort((a, b) => b.responses - a.responses);

    kpis.innerHTML = [
      ['Unique sites', siteFilter ? 1 : indicationFilter ? sitesForReport.length : state.sites.length || uniqueSiteCount],
      ['Studies', studyFilter ? 1 : filteredStudies.length],
      ['Outcome rows', outcomes.length],
      ['Feasibility responses', feas.length],
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

    destroyCharts();
    if (global.Chart) {
      const ctx1 = document.getElementById('legacy-chart-studies');
      const ctx2 = document.getElementById('legacy-chart-funnel');
      if (state.reportMode === 'bySite') {
        let siteRows = sitesForReport
          .map((s) => {
            const rows = outcomes.filter((o) => o.siteId === s.id);
            const t = sumOutcomes(rows);
            return { ...s, _t: t, _rows: rows };
          })
          .filter((s) => s._rows.length > 0 || (state.feasibilityResponses || []).some((r) => r.siteId === s.id))
          .sort((a, b) => b._t.enrolled - a._t.enrolled);
        const top = siteRows.slice(0, 12);
        if (ctx1) {
          charts.studies = new global.Chart(ctx1, {
            type: 'bar',
            data: {
              labels: top.map((s) => s.name),
              datasets: [{ label: 'Enrolled', data: top.map((s) => s._t.enrolled), backgroundColor: '#4f46e5' }],
            },
            options: { indexAxis: 'y', plugins: { legend: { display: false } }, responsive: true },
          });
        }
      } else {
        const top = [...filteredStudies]
          .sort((a, b) => num(b.metrics?.enrolled) - num(a.metrics?.enrolled))
          .slice(0, 12);
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
      }
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

    if (state.reportMode === 'bySite') {
      const siteRows = sitesForReport
        .map((s) => {
          const rows = outcomes.filter((o) => o.siteId === s.id);
          const t = sumOutcomes(rows);
          const studyNames = [...new Set(rows.map((r) => r.studyName))];
          const feasCount = (state.feasibilityResponses || []).filter((r) => r.siteId === s.id).length;
          return { site: s, rows, t, studyNames, feasCount };
        })
        .filter((x) => x.rows.length > 0 || x.feasCount > 0)
        .sort((a, b) => b.t.enrolled - a.t.enrolled || b.feasCount - a.feasCount);

      tables.innerHTML = `
        <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
          <div class="px-3 py-2 font-semibold border-b dark:border-gray-700">
            <div>Sites (${siteRows.length} unique)</div>
            <div class="text-xs font-normal text-gray-500">Tap a site for full metrics & relationship notes</div>
          </div>
          <div class="md:hidden divide-y dark:divide-gray-700">
            ${siteRows
              .map(({ site: s, rows, t, studyNames }) => {
                return `<button type="button" data-legacy-report-open-site="${escapeHtml(s.id)}"
                  class="w-full text-left p-4 hover:bg-gray-50 dark:hover:bg-gray-700/40 active:bg-indigo-50 dark:active:bg-indigo-900/20">
                  <div class="flex items-start justify-between gap-2 mb-2">
                    <div class="min-w-0">
                      <div class="font-semibold text-gray-900 dark:text-white truncate">${escapeHtml(s.name)}</div>
                      <div class="text-xs text-gray-500">${studyNames.length} studies · ${rows.length} rows</div>
                    </div>
                    ${preferenceBadge(s.relationshipPreference)}
                  </div>
                  <div class="grid grid-cols-3 gap-1.5 mb-2">
                    ${metricChip('Sched', fmt(t.scheduled))}
                    ${metricChip('Screen', fmt(t.screened))}
                    ${metricChip('Enrolled', fmt(t.enrolled), true)}
                  </div>
                  <div class="flex justify-between text-xs text-gray-500">
                    <span>E/S ${rate(t.enrolled, t.screened)}</span>
                    <span class="text-indigo-600 dark:text-indigo-300 font-medium">Open →</span>
                  </div>
                </button>`;
              })
              .join('')}
          </div>
          <div class="hidden md:block overflow-x-auto">
            <table class="min-w-full text-sm">
              <thead><tr class="text-left bg-gray-50 dark:bg-gray-900/40">
                <th class="px-3 py-2">Site</th>
                <th class="px-3 py-2">Site Status</th>
                <th class="px-3 py-2">Code</th>
                <th class="px-3 py-2 text-right">Studies</th>
                <th class="px-3 py-2 text-right">Rows</th>
                <th class="px-3 py-2 text-right">Target</th>
                <th class="px-3 py-2 text-right">Sched</th>
                <th class="px-3 py-2 text-right">Screen</th>
                <th class="px-3 py-2 text-right">Enrolled</th>
                <th class="px-3 py-2 text-right">E/S</th>
                <th class="px-3 py-2"></th>
              </tr></thead>
              <tbody>
                ${siteRows
                  .map(({ site: s, rows, t, studyNames }) => {
                    const m = s.metrics || {};
                    return `<tr class="border-t dark:border-gray-700">
                      <td class="px-3 py-1.5 font-medium">${escapeHtml(s.name)}</td>
                      <td class="px-3 py-1.5">${preferenceBadge(s.relationshipPreference)}</td>
                      <td class="px-3 py-1.5 text-xs">${escapeHtml(s.siteCode || '—')}</td>
                      <td class="px-3 py-1.5 text-right">${studyNames.length || m.nStudies || '—'}</td>
                      <td class="px-3 py-1.5 text-right">${rows.length}</td>
                      <td class="px-3 py-1.5 text-right">${fmt(t.targetScheduled)}</td>
                      <td class="px-3 py-1.5 text-right">${fmt(t.scheduled)}</td>
                      <td class="px-3 py-1.5 text-right">${fmt(t.screened)}</td>
                      <td class="px-3 py-1.5 text-right font-semibold">${fmt(t.enrolled)}</td>
                      <td class="px-3 py-1.5 text-right">${rate(t.enrolled, t.screened)}</td>
                      <td class="px-3 py-1.5 text-right">
                        <button type="button" data-legacy-report-open-site="${escapeHtml(s.id)}" class="${TAP_BTN}">Open</button>
                      </td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="space-y-2">
          <h3 class="font-semibold text-gray-900 dark:text-white">Site → studies (drill-down)</h3>
          ${siteRows
            .map(({ site: s, rows, t, studyNames }) => {
              // roll up by study under this site
              const byStudy = {};
              for (const o of rows) {
                if (!byStudy[o.studyId]) {
                  byStudy[o.studyId] = { studyId: o.studyId, studyName: o.studyName, rows: [] };
                }
                byStudy[o.studyId].rows.push(o);
              }
              const studyParts = Object.values(byStudy)
                .map((st) => {
                  const stTot = sumOutcomes(st.rows);
                  const meta = state.studies.find((x) => x.id === st.studyId);
                  const ta = meta?.therapeuticArea || meta?.indication || '—';
                  return `<tr class="border-t dark:border-gray-700">
                    <td class="px-2 py-1.5">${escapeHtml(st.studyName)}</td>
                    <td class="px-2 py-1.5">${escapeHtml(ta)}</td>
                    <td class="px-2 py-1.5 text-right">${st.rows.length}</td>
                    <td class="px-2 py-1.5 text-right">${fmt(stTot.scheduled)}</td>
                    <td class="px-2 py-1.5 text-right">${fmt(stTot.screened)}</td>
                    <td class="px-2 py-1.5 text-right">${fmt(stTot.enrolled)}</td>
                    <td class="px-2 py-1.5 text-right">${rate(stTot.enrolled, stTot.screened)}</td>
                  </tr>`;
                })
                .join('');
              return `
              <details class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800" ${siteFilter ? 'open' : ''}>
                <summary class="cursor-pointer px-3 py-3 min-h-[44px] font-semibold flex flex-wrap gap-x-4 gap-y-1 items-center">
                  <span>${escapeHtml(s.name)}</span>
                  ${preferenceBadge(s.relationshipPreference)}
                  <span class="text-xs font-normal text-gray-500">${studyNames.length} studies · enrolled ${fmt(t.enrolled)}</span>
                </summary>
                <div class="px-3 pb-3 border-t dark:border-gray-700 space-y-3">
                  <button type="button" data-legacy-report-open-site="${escapeHtml(s.id)}" class="${TAP_BTN} w-full sm:w-auto mt-2">Open site detail</button>
                  <div class="overflow-x-auto pt-2">
                    <table class="min-w-full text-sm">
                      <thead><tr class="text-left bg-gray-50 dark:bg-gray-900/40">
                        <th class="px-2 py-2">Study</th><th class="px-2 py-2">TA / Indication</th>
                        <th class="px-2 py-2 text-right">Rows</th>
                        <th class="px-2 py-2 text-right">Sched</th><th class="px-2 py-2 text-right">Screen</th>
                        <th class="px-2 py-2 text-right">Enrolled</th><th class="px-2 py-2 text-right">E/S</th>
                      </tr></thead>
                      <tbody>${studyParts}</tbody>
                    </table>
                  </div>
                  <div>
                    <div class="text-sm font-medium mb-1">Site × group detail</div>
                    ${siteOutcomesTableHtml(rows, { showStudy: true })}
                  </div>
                </div>
              </details>`;
            })
            .join('') || '<p class="text-sm text-gray-500">No sites in filter.</p>'}
        </div>`;
      tables.querySelectorAll('[data-legacy-report-open-site]').forEach((btn) => {
        btn.addEventListener('click', () => openSiteDetail(btn.getAttribute('data-legacy-report-open-site')));
      });
      tables.innerHTML += feasByIndicationSectionHtml(feasRows, feas.length);
      return;
    }

    // ---- By Study mode ----
    const studyList = studyFilter ? filteredStudies : filteredStudies;
    const studyBlocks = studyList
      .sort((a, b) => num(b.metrics?.enrolled) - num(a.metrics?.enrolled))
      .map((s) => {
        const rows = outcomes.filter((o) => o.studyId === s.id);
        const t = sumOutcomes(rows);
        return `
          <details class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800" ${studyFilter ? 'open' : ''}>
            <summary class="cursor-pointer px-3 py-2 font-semibold flex flex-wrap gap-x-4 gap-y-1 items-center">
              <span>${escapeHtml(s.name)}</span>
              <span class="text-xs font-normal text-gray-500">${escapeHtml(s.therapeuticArea || s.indication || '')}</span>
              <span class="text-xs font-normal text-gray-500">${rows.length} rows · ${t.sites.size} sites · enrolled ${fmt(t.enrolled)}</span>
            </summary>
            <div class="px-3 pb-3 space-y-3 border-t dark:border-gray-700">
              <div class="pt-2">
                <div class="text-sm font-medium mb-1">By site (unique under this study)</div>
                ${siteRollupTableHtml(rows)}
              </div>
              <div>
                <div class="text-sm font-medium mb-1">Site × group detail</div>
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
            <th class="px-3 py-2">Study</th><th class="px-3 py-2">TA / Indication</th>
            <th class="px-3 py-2 text-right">Sites</th>
            <th class="px-3 py-2 text-right">Sched</th><th class="px-3 py-2 text-right">Screen</th>
            <th class="px-3 py-2 text-right">Enrolled</th><th class="px-3 py-2 text-right">E/S</th>
          </tr></thead>
          <tbody>
            ${studyList
              .map((s) => {
                const m = s.metrics || {};
                return `<tr class="border-t dark:border-gray-700">
                  <td class="px-3 py-1.5 font-medium">${escapeHtml(s.name)}</td>
                  <td class="px-3 py-1.5">${escapeHtml(s.therapeuticArea || s.indication || '—')}</td>
                  <td class="px-3 py-1.5 text-right">${fmt(m.nSites)}</td>
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
      <div class="space-y-2">
        <h3 class="font-semibold text-gray-900 dark:text-white">Breakdown by study → site</h3>
        ${studyBlocks || '<p class="text-sm text-gray-500">No studies in filter.</p>'}
      </div>`;
    tables.innerHTML += feasByIndicationSectionHtml(feasRows, feas.length);
  }

  function feasByIndicationSectionHtml(feasRows, totalFeas) {
    return `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden mt-4">
        <div class="px-3 py-2 font-semibold border-b dark:border-gray-700">
          Feasibility by indication / TA (${totalFeas} responses)
          <div class="text-xs font-normal text-gray-500">SurveyMonkey + Monday master ingest · TA = Indication</div>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-900/40 text-left">
              <tr>
                <th class="px-3 py-2">Indication / TA</th>
                <th class="px-3 py-2 text-right">Responses</th>
                <th class="px-3 py-2 text-right">Sites</th>
                <th class="px-3 py-2 text-right">Survey defs</th>
              </tr>
            </thead>
            <tbody>
              ${feasRows.length
                ? feasRows
                    .map(
                      (r) => `<tr class="border-t dark:border-gray-700">
                  <td class="px-3 py-1.5 font-medium">${escapeHtml(r.indication)}</td>
                  <td class="px-3 py-1.5 text-right">${r.responses}</td>
                  <td class="px-3 py-1.5 text-right">${r.sites}</td>
                  <td class="px-3 py-1.5 text-right">${r.surveys}</td>
                </tr>`
                    )
                    .join('')
                : `<tr><td colspan="4" class="px-3 py-4 text-sm text-gray-500 text-center">No feasibility responses in filter.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function exportCsv() {
    const headers = [
      'siteId',
      'siteName',
      'studyName',
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
    document.getElementById('legacy-study-sort')?.addEventListener('change', (e) => {
      state.studySort = e.target.value || 'name-asc';
      renderStudiesTable(document.getElementById('legacy-study-search')?.value || '');
    });
    document.getElementById('legacy-studies-refresh')?.addEventListener('click', async () => {
      state.loaded = false;
      await ensureLoaded(true);
      renderStudiesTable(document.getElementById('legacy-study-search')?.value || '');
    });
  }

  async function mountSites() {
    await ensureLoaded();
    populateIndicationFilter('legacy-site-indication-filter');
    const rerender = () =>
      renderSitesTable(
        document.getElementById('legacy-site-search')?.value || '',
        document.getElementById('legacy-site-pref-filter')?.value || '',
        document.getElementById('legacy-site-indication-filter')?.value || ''
      );
    rerender();
    document.getElementById('legacy-site-search')?.addEventListener('input', rerender);
    document.getElementById('legacy-site-pref-filter')?.addEventListener('change', rerender);
    document.getElementById('legacy-site-indication-filter')?.addEventListener('change', rerender);
    document.getElementById('legacy-site-sort')?.addEventListener('change', (e) => {
      state.siteSort = e.target.value || 'name-asc';
      rerender();
    });
    document.getElementById('legacy-sites-refresh')?.addEventListener('click', async () => {
      state.loaded = false;
      await ensureLoaded(true);
      populateIndicationFilter('legacy-site-indication-filter');
      const detail = document.getElementById('legacy-site-detail');
      if (detail && !detail.classList.contains('hidden') && state.selectedSiteId) {
        await openSiteDetail(state.selectedSiteId);
      } else {
        rerender();
      }
    });

    const root = document.getElementById('legacy-sites-root') || document.getElementById('legacy-sites-table-wrap')?.parentElement;
    if (root && !root.dataset.promoteBound) {
      root.dataset.promoteBound = '1';
      document.getElementById('legacy-promote-selected')?.addEventListener('click', () => openPromoteWizard({ all: false }));
      document.getElementById('legacy-promote-all')?.addEventListener('click', () => openPromoteWizard({ all: true }));
    }
    updatePromoteToolbar();

    if (global.__legacyPendingSiteId) {
      const id = global.__legacyPendingSiteId;
      global.__legacyPendingSiteId = null;
      await openSiteDetail(id);
    }
  }

  function surveyDefIndication(def) {
    return (
      (def && (def.indication || def.therapeuticArea || (def.study && def.study.indication))) ||
      ''
    )
      .toString()
      .trim();
  }

  function responsesForSurvey(surveyId) {
    return (state.feasibilityResponses || []).filter((r) => r && r.surveyId === surveyId && !r._archived);
  }

  /** Latest response per site for one survey definition. */
  function latestResponsesBySiteForSurvey(surveyId) {
    const grouped = new Map();
    responsesForSurvey(surveyId)
      .slice()
      .sort((a, b) =>
        String(b.submittedAt || b.createdAt || '').localeCompare(String(a.submittedAt || a.createdAt || ''))
      )
      .forEach((r) => {
        const key = r.siteId || r.id;
        if (!grouped.has(key)) grouped.set(key, r);
      });
    return Array.from(grouped.values());
  }

  function buildFeasibilitySurveyRows() {
    const bySurvey = new Map();
    for (const r of state.feasibilityResponses || []) {
      if (!r || r._archived || !r.surveyId) continue;
      if (!bySurvey.has(r.surveyId)) bySurvey.set(r.surveyId, []);
      bySurvey.get(r.surveyId).push(r);
    }

    const defIds = new Set((state.feasibilityDefs || []).map((d) => d.id));
    const rows = [];

    for (const def of state.feasibilityDefs || []) {
      const responses = bySurvey.get(def.id) || [];
      const sites = new Set(responses.map((r) => r.siteId).filter(Boolean));
      const inds = new Set();
      const di = surveyDefIndication(def);
      if (di) inds.add(di);
      for (const r of responses) {
        const i = r.indication || r.therapeuticArea || (r.study && r.study.indication);
        if (i) inds.add(String(i).trim());
      }
      rows.push({
        id: def.id,
        title: def.title || def.id,
        platform: def.platform || def.source || def.sourcePlatform || '',
        indication: di,
        indications: [...inds].filter(Boolean).sort((a, b) => a.localeCompare(b)),
        responseCount: responses.length,
        siteCount: sites.size,
        questionCount: Array.isArray(def.questions) ? def.questions.length : def.questionCount || 0,
        def,
      });
    }

    // Orphan responses with no definition doc
    for (const [surveyId, responses] of bySurvey) {
      if (defIds.has(surveyId)) continue;
      const sites = new Set(responses.map((r) => r.siteId).filter(Boolean));
      const inds = new Set();
      for (const r of responses) {
        const i = r.indication || r.therapeuticArea || (r.study && r.study.indication);
        if (i) inds.add(String(i).trim());
      }
      const title =
        responses[0]?.study?.study_name ||
        responses[0]?.sourceTab ||
        surveyId;
      rows.push({
        id: surveyId,
        title,
        platform: responses[0]?.platform || '',
        indication: [...inds][0] || '',
        indications: [...inds].filter(Boolean).sort((a, b) => a.localeCompare(b)),
        responseCount: responses.length,
        siteCount: sites.size,
        questionCount: 0,
        def: null,
      });
    }

    return rows;
  }

  function renderFeasibilitySummary(el, rows) {
    if (!el) return;
    const totalResponses = rows.reduce((n, r) => n + r.responseCount, 0);
    const totalSites = new Set(
      (state.feasibilityResponses || []).filter((r) => r && !r._archived && r.siteId).map((r) => r.siteId)
    ).size;
    el.innerHTML = [
      ['Surveys', rows.length],
      ['Responses', totalResponses],
      ['Sites with responses', totalSites],
      ['Definitions', (state.feasibilityDefs || []).length],
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

  function renderFeasibilitySurveysList(search = '', indication = '') {
    const wrap = document.getElementById('legacy-feas-table-wrap');
    const status = document.getElementById('legacy-feas-load-status');
    if (!wrap) return;

    let rows = buildFeasibilitySurveyRows();
    const q = (search || '').trim().toLowerCase();
    const ind = (indication || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          (r.platform || '').toLowerCase().includes(q) ||
          r.indications.some((i) => i.toLowerCase().includes(q))
      );
    }
    if (ind) {
      rows = rows.filter((r) => r.indications.some((i) => i.toLowerCase() === ind));
    }

    const sort = state.feasSort || 'responses-desc';
    rows.sort((a, b) => {
      if (sort === 'name-asc') return a.title.localeCompare(b.title);
      if (sort === 'name-desc') return b.title.localeCompare(a.title);
      if (sort === 'responses-asc') return a.responseCount - b.responseCount || a.title.localeCompare(b.title);
      return b.responseCount - a.responseCount || a.title.localeCompare(b.title);
    });

    renderFeasibilitySummary(document.getElementById('legacy-feas-summary'), buildFeasibilitySurveyRows());
    if (status) {
      status.textContent = `${rows.length} survey${rows.length === 1 ? '' : 's'} shown · ${state.feasibilityResponses.length} total responses`;
    }

    if (!rows.length) {
      wrap.innerHTML = `<div class="p-6 text-sm text-gray-500">No feasibility surveys match these filters.</div>`;
      return;
    }

    const mobile = rows
      .map(
        (r) => `
      <button type="button" class="legacy-feas-open w-full text-left rounded-lg border dark:border-gray-700 p-3 hover:bg-gray-50 dark:hover:bg-gray-900/40 transition"
        data-survey-id="${escapeHtml(r.id)}">
        <div class="font-medium text-gray-900 dark:text-white">${escapeHtml(r.title)}</div>
        <div class="flex flex-wrap gap-1.5 mt-1.5">${indicationPills(r.indications)}</div>
        <div class="grid grid-cols-3 gap-1.5 mt-2">
          ${metricChip('Sites', r.siteCount)}
          ${metricChip('Responses', r.responseCount, true)}
          ${metricChip('Qs', r.questionCount || '—')}
        </div>
      </button>`
      )
      .join('');

    const desktop = `
      <table class="min-w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-900/40 text-left">
          <tr>
            <th class="px-3 py-2">Survey</th>
            <th class="px-3 py-2">Indication / TA</th>
            <th class="px-3 py-2">Platform</th>
            <th class="px-3 py-2 text-right">Sites</th>
            <th class="px-3 py-2 text-right">Responses</th>
            <th class="px-3 py-2 text-right">Questions</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr class="border-t dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900/30">
              <td class="px-3 py-2 font-medium text-gray-900 dark:text-white">${escapeHtml(r.title)}</td>
              <td class="px-3 py-2">${indicationPills(r.indications)}</td>
              <td class="px-3 py-2 text-xs text-gray-500">${escapeHtml(r.platform || '—')}</td>
              <td class="px-3 py-2 text-right">${r.siteCount}</td>
              <td class="px-3 py-2 text-right font-semibold text-indigo-600 dark:text-indigo-300">${r.responseCount}</td>
              <td class="px-3 py-2 text-right">${r.questionCount || '—'}</td>
              <td class="px-3 py-2 text-right">
                <button type="button" class="legacy-feas-open ${TAP_LINK}" data-survey-id="${escapeHtml(r.id)}">Open</button>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;

    wrap.innerHTML = `
      <div class="md:hidden p-2 space-y-2">${mobile}</div>
      <div class="hidden md:block overflow-x-auto">${desktop}</div>`;

    wrap.querySelectorAll('.legacy-feas-open').forEach((btn) => {
      btn.addEventListener('click', () => openFeasibilitySurvey(btn.getAttribute('data-survey-id')));
    });
  }

  function siteNameForId(siteId) {
    const sites = uniqueSitesFromState();
    const s = sites.find((x) => x.id === siteId) || (state.sites || []).find((x) => x.id === siteId);
    return s?.name || siteId || 'Unknown site';
  }

  function openFeasibilitySurvey(surveyId) {
    state.selectedSurveyId = surveyId;
    const wrap = document.getElementById('legacy-feas-table-wrap');
    const summary = document.getElementById('legacy-feas-summary');
    const detail = document.getElementById('legacy-feas-detail');
    if (!detail) return;

    const rows = buildFeasibilitySurveyRows();
    const meta = rows.find((r) => r.id === surveyId);
    const def = (state.feasibilityDefs || []).find((d) => d.id === surveyId) || meta?.def;
    const title = meta?.title || def?.title || surveyId;
    const surveyUi = global.ArtemisSurveyUI;
    if (surveyUi?.syncCache) {
      surveyUi.syncCache({
        definitions: state.feasibilityDefs,
        responses: state.feasibilityResponses,
      });
    }

    let siteResponses = latestResponsesBySiteForSurvey(surveyId);
    const detailSearchEl = document.getElementById('legacy-feas-detail-search');
    const siteSearch = (detailSearchEl?.value || '').trim().toLowerCase();
    if (siteSearch) {
      siteResponses = siteResponses.filter((r) => {
        const name = siteNameForId(r.siteId).toLowerCase();
        return (
          name.includes(siteSearch) ||
          String(r.siteId || '')
            .toLowerCase()
            .includes(siteSearch) ||
          String(r.displayName || '')
            .toLowerCase()
            .includes(siteSearch)
        );
      });
    }
    siteResponses.sort((a, b) => siteNameForId(a.siteId).localeCompare(siteNameForId(b.siteId)));

    wrap?.classList.add('hidden');
    summary?.classList.add('hidden');
    detail.classList.remove('hidden');

    const inds = meta?.indications || [];
    const totalSites = latestResponsesBySiteForSurvey(surveyId).length;
    const cards = siteResponses
      .map((r, idx) => {
        const siteName = siteNameForId(r.siteId);
        const when = r.submittedAt
          ? new Date(r.submittedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
          : r.createdAt
            ? new Date(r.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
            : 'N/A';
        const answerCount = surveyUi?.surveyAnswerCount ? surveyUi.surveyAnswerCount(r) : (r.answers || []).length;
        const scoreBadge = surveyUi?.surveyScoreBadgeHtml ? surveyUi.surveyScoreBadgeHtml(r) : '';
        const answersHtml = surveyUi?.surveyAnswersListHtml
          ? surveyUi.surveyAnswersListHtml(r, { skipEmpty: true })
          : '<p class="text-sm text-gray-500">Survey UI not loaded.</p>';
        const openFirst = idx === 0 ? ' open' : '';
        const ind = r.indication || r.therapeuticArea || '';
        return `
          <details class="survey-accordion"${openFirst}>
            <summary>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-semibold text-gray-900 dark:text-gray-100">${escapeHtml(siteName)}</span>
                  ${scoreBadge}
                </div>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-500 dark:text-gray-400">
                  <span>${escapeHtml(when)}</span>
                  <span>${answerCount} answer${answerCount === 1 ? '' : 's'}</span>
                  ${ind ? `<span>${escapeHtml(ind)}</span>` : ''}
                  ${r.displayName ? `<span>${escapeHtml(r.displayName)}</span>` : ''}
                </div>
              </div>
            </summary>
            <div class="survey-accordion-body">
              ${answersHtml}
              <div class="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex flex-wrap gap-3 justify-end">
                <button type="button" class="legacy-feas-open-site text-sm text-indigo-600 dark:text-indigo-400 hover:underline font-medium" data-site-id="${escapeHtml(r.siteId || '')}">Open site</button>
                <button type="button" class="view-site-survey-response-btn text-sm text-indigo-600 dark:text-indigo-400 hover:underline font-medium" data-response-id="${escapeHtml(r.id)}">Open full view</button>
              </div>
            </div>
          </details>`;
      })
      .join('');

    detail.innerHTML = `
      <div class="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4 space-y-4">
        <div>
          <button type="button" id="legacy-back-feas" class="${TAP_BACK}">← All feasibility surveys</button>
          <h3 class="text-xl font-bold text-gray-900 dark:text-white mt-1">${escapeHtml(title)}</h3>
          <p class="text-sm text-gray-500 mt-1">
            <span class="font-mono text-xs">${escapeHtml(surveyId)}</span>
            · ${siteSearch ? `${siteResponses.length} of ${totalSites}` : totalSites} site${totalSites === 1 ? '' : 's'}
            · ${meta?.responseCount ?? responsesForSurvey(surveyId).length} response(s)
            ${meta?.platform ? ` · ${escapeHtml(meta.platform)}` : ''}
          </p>
          <div class="flex flex-wrap gap-1.5 mt-2">
            ${inds.map((i) => `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">${escapeHtml(i)}</span>`).join('') || '<span class="text-xs text-gray-400">No indication / TA tagged</span>'}
          </div>
        </div>
        <div class="flex flex-col sm:flex-row gap-2">
          <input id="legacy-feas-detail-search" type="search" placeholder="Filter sites in this survey…"
            class="px-3 py-3 sm:py-2 border rounded-md dark:bg-gray-900 dark:border-gray-600 text-base sm:text-sm w-full sm:flex-1 min-h-[44px]"
            value="${escapeHtml(siteSearch)}" />
        </div>
        <div class="space-y-3">
          ${cards || '<p class="text-sm text-gray-500 py-4 text-center">No site responses for this survey.</p>'}
        </div>
      </div>`;

    document.getElementById('legacy-back-feas')?.addEventListener('click', () => {
      detail.classList.add('hidden');
      detail.innerHTML = '';
      wrap?.classList.remove('hidden');
      summary?.classList.remove('hidden');
      state.selectedSurveyId = null;
      renderFeasibilitySurveysList(
        document.getElementById('legacy-feas-search')?.value || '',
        document.getElementById('legacy-feas-indication-filter')?.value || ''
      );
    });

    let searchTimer;
    document.getElementById('legacy-feas-detail-search')?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => openFeasibilitySurvey(surveyId), 150);
    });

    detail.querySelectorAll('.view-site-survey-response-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-response-id');
        const response = (state.feasibilityResponses || []).find((r) => r.id === id);
        if (response && surveyUi?.createSiteSurveyResponseModal) {
          surveyUi.createSiteSurveyResponseModal(response);
        }
      });
    });

    detail.querySelectorAll('.legacy-feas-open-site').forEach((btn) => {
      btn.addEventListener('click', () => {
        const siteId = btn.getAttribute('data-site-id');
        if (!siteId) return;
        global.__legacyPendingSiteId = siteId;
        goArtemisTab('legacy-sites');
      });
    });

    const searchInput = document.getElementById('legacy-feas-detail-search');
    if (searchInput && siteSearch) {
      searchInput.focus();
      const len = searchInput.value.length;
      try {
        searchInput.setSelectionRange(len, len);
      } catch (_) {}
    }
  }

  async function mountFeasibility() {
    await ensureLoaded();
    populateIndicationFilter('legacy-feas-indication-filter');
    const rerender = () =>
      renderFeasibilitySurveysList(
        document.getElementById('legacy-feas-search')?.value || '',
        document.getElementById('legacy-feas-indication-filter')?.value || ''
      );
    const detail = document.getElementById('legacy-feas-detail');
    if (detail && !detail.classList.contains('hidden') && state.selectedSurveyId) {
      openFeasibilitySurvey(state.selectedSurveyId);
    } else {
      rerender();
    }
    document.getElementById('legacy-feas-search')?.addEventListener('input', rerender);
    document.getElementById('legacy-feas-indication-filter')?.addEventListener('change', rerender);
    document.getElementById('legacy-feas-sort')?.addEventListener('change', (e) => {
      state.feasSort = e.target.value || 'responses-desc';
      rerender();
    });
    document.getElementById('legacy-feas-refresh')?.addEventListener('click', async () => {
      state.loaded = false;
      await ensureLoaded(true);
      populateIndicationFilter('legacy-feas-indication-filter');
      if (detail && !detail.classList.contains('hidden') && state.selectedSurveyId) {
        openFeasibilitySurvey(state.selectedSurveyId);
      } else {
        rerender();
      }
    });
    if (global.__legacyPendingSurveyId) {
      const id = global.__legacyPendingSurveyId;
      global.__legacyPendingSurveyId = null;
      openFeasibilitySurvey(id);
    }
  }

  async function mountReporting() {
    await ensureLoaded();
    const studySel = document.getElementById('legacy-report-study');
    const siteSel = document.getElementById('legacy-report-site');
    const indSel = document.getElementById('legacy-report-indication');
    if (studySel) studySel.innerHTML = '<option value="">All studies</option>';
    if (siteSel) siteSel.innerHTML = '<option value="">All sites</option>';
    populateIndicationFilter('legacy-report-indication');
    setReportMode('bySite');
    renderReporting();
    studySel?.addEventListener('change', renderReporting);
    siteSel?.addEventListener('change', renderReporting);
    indSel?.addEventListener('change', renderReporting);
    document.getElementById('legacy-mode-site')?.addEventListener('click', () => {
      setReportMode('bySite');
      renderReporting();
    });
    document.getElementById('legacy-mode-study')?.addEventListener('click', () => {
      setReportMode('byStudy');
      renderReporting();
    });
    document.getElementById('legacy-report-refresh')?.addEventListener('click', async () => {
      state.loaded = false;
      await ensureLoaded(true);
      if (studySel) studySel.innerHTML = '<option value="">All studies</option>';
      if (siteSel) siteSel.innerHTML = '<option value="">All sites</option>';
      populateIndicationFilter('legacy-report-indication');
      renderReporting();
    });
    document.getElementById('legacy-report-export')?.addEventListener('click', exportCsv);
  }

  function attachApiMethods() {
    if (!global.apiService) return;
    global.apiService.getLegacyStudies = () => global.apiService.request('/legacy-studies');
    global.apiService.getLegacySites = () => global.apiService.request('/legacy-sites');
    global.apiService.updateLegacySite = (id, body) =>
      global.apiService.request(`/legacy-sites/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    global.apiService.updateLegacyStudy = (id, body) =>
      global.apiService.request(`/legacy-studies/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    global.apiService.getLegacyOutcomes = (studyId) =>
      global.apiService.request(
        studyId ? `/legacy-study-site-outcomes?studyId=${encodeURIComponent(studyId)}` : '/legacy-study-site-outcomes'
      );
  }

  global.ArtemisLegacy = {
    getLegacyStudiesHTML,
    getLegacySitesHTML,
    getLegacyFeasibilityHTML,
    getLegacyReportingHTML,
    getLegacyDashboardHTML,
    mountStudies,
    mountSites,
    mountFeasibility,
    mountReporting,
    mountDashboard,
    openSiteDetail,
    openFeasibilitySurvey,
    ensureLoaded,
    ensureLegacySitesForMatching,
    refreshArtemisLegacyIndex,
    rebuildArtemisLegacyIndex,
    getLegacyForArtemisSite,
    attachApiMethods,
    state,
  };
})(window);
