/**
 * CHAOS React Lab — experimental read-only mirror of live schedule data.
 * Production scheduler stays vanilla. This mounts only when the React Lab tab is open.
 */
import React, { useEffect, useMemo, useState } from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';

const { createElement: h, Fragment } = React;

function useChaosSnapshot(tick) {
  return useMemo(() => {
    const bridge = window.__CHAOS_REACT_LAB__;
    if (!bridge || typeof bridge.getSnapshot !== 'function') {
      return { error: 'Bridge not ready. Open React Lab after CHAOS has loaded.', events: [], sites: [], studies: [], crcs: [], monthKey: '', calendarDate: null };
    }
    try {
      return bridge.getSnapshot();
    } catch (err) {
      return { error: String(err?.message || err), events: [], sites: [], studies: [], crcs: [], monthKey: '', calendarDate: null };
    }
  }, [tick]);
}

function eventDateKey(event) {
  const raw = String(event?.date || event?.startDate || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function LabApp() {
  const [tick, setTick] = useState(0);
  const snap = useChaosSnapshot(tick);
  const siteName = (id) => snap.sites.find((s) => s.id === id)?.name || id || '—';
  const studyName = (ids) => {
    if (!Array.isArray(ids) || !ids.length) return '—';
    return ids.map((id) => snap.studies.find((s) => s.id === id)?.title || snap.studies.find((s) => s.id === id)?.name || id).join(', ');
  };
  const staffNames = (event) => {
    if (typeof snap.resolveStaffNames === 'function') return snap.resolveStaffNames(event);
    return [];
  };

  const byDate = useMemo(() => {
    const map = new Map();
    (snap.events || []).forEach((event) => {
      const d = eventDateKey(event);
      if (!d) return;
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(event);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [snap.events]);

  return h('div', { className: 'space-y-4' },
    h('div', { className: 'rounded-lg border border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/40 p-4' },
      h('div', { className: 'flex flex-wrap items-start justify-between gap-3' },
        h('div', null,
          h('h2', { className: 'text-xl font-bold text-violet-900 dark:text-violet-100' }, 'React Lab (experimental)'),
          h('p', { className: 'text-sm text-violet-800/80 dark:text-violet-200/80 mt-1 max-w-2xl' },
            'Read-only mirror of the same live CHAOS data the vanilla scheduler uses. Edits still happen in production views. This sandbox is for trying React patterns without touching mid-production UI.'
          )
        ),
        h('button', {
          type: 'button',
          className: 'px-3 py-1.5 rounded-md bg-violet-700 text-white text-sm hover:bg-violet-800',
          onClick: () => setTick((t) => t + 1)
        }, 'Refresh from live state')
      ),
      h('p', { className: 'text-xs text-violet-700 dark:text-violet-300 mt-3' },
        `Month ${snap.monthKey || '—'} · ${snap.events?.length || 0} site assignments in view · React ${React.version}`
      )
    ),
    snap.error
      ? h('div', { className: 'p-4 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm' }, snap.error)
      : null,
    !snap.error && byDate.length === 0
      ? h('p', { className: 'text-sm text-gray-500 dark:text-gray-400' }, 'No Site Assignment rows for this month in live state.')
      : null,
    h('div', { className: 'space-y-3' },
      ...byDate.map(([date, events]) =>
        h('section', { key: date, className: 'rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60 overflow-hidden' },
          h('header', { className: 'px-3 py-2 bg-gray-100 dark:bg-gray-800 text-sm font-semibold text-gray-800 dark:text-gray-100' },
            date, ` · ${events.length} visit${events.length === 1 ? '' : 's'}`
          ),
          h('ul', { className: 'divide-y divide-gray-100 dark:divide-gray-800' },
            ...events.map((event) => {
              const names = staffNames(event);
              return h('li', { key: event.id || `${date}-${event.siteId}`, className: 'px-3 py-2 text-sm' },
                h('div', { className: 'font-medium text-gray-900 dark:text-white' }, siteName(event.siteId)),
                h('div', { className: 'text-gray-600 dark:text-gray-400' }, studyName(event.studyIds)),
                h('div', { className: 'text-gray-500 dark:text-gray-400 mt-0.5' },
                  names.length ? names.join(', ') : 'Unassigned / open',
                  event.visitNumber ? ` · Visit ${event.visitNumber}` : '',
                  event.groupNumber ? ` · Group ${event.groupNumber}` : '',
                  event.hours != null ? ` · ${event.hours}h` : ''
                )
              );
            })
          )
        )
      )
    )
  );
}

let root = null;
let hostEl = null;

export function mountReactLab(container) {
  if (!container) return;
  hostEl = container;
  if (!root) root = createRoot(container);
  root.render(h(LabApp));
}

export function unmountReactLab() {
  if (root) {
    root.unmount();
    root = null;
  }
  hostEl = null;
}

export function remountReactLab() {
  if (hostEl) mountReactLab(hostEl);
}
