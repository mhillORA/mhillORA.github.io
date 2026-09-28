/**
 * CHAOS React Lab — same calendar structure as production Scheduler.
 * Header / view controls are React; body markup comes from the identical
 * production view builders (monthly / weekly / daily planning grids, month, week).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';

const { createElement: h, Fragment } = React;

function bridge() {
  return window.__CHAOS_REACT_LAB__ || null;
}

function cloneDate(value) {
  if (!value) return new Date();
  if (value instanceof Date) return new Date(value.getTime());
  const b = bridge();
  if (b?.parseDateOnly) {
    const parsed = b.parseDateOnly(value);
    if (parsed) return parsed;
  }
  const d = new Date(String(value).length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function toIso(date) {
  const b = bridge();
  if (b?.toDateOnlyString) return b.toDateOnlyString(date);
  const d = cloneDate(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthValue(date) {
  const d = cloneDate(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function titleForView(view) {
  const d = cloneDate(view.calendarDate);
  const monthName = d.toLocaleString('default', { month: 'long', year: 'numeric' });
  const dayName = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  // CHAOS calendar weeks start on Sunday (getDaySaturdayStart currently returns getDay())
  const startOfWeek = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  const weekName = `Week of ${startOfWeek.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;

  if (view.calendarView === 'week') return weekName;
  if (view.calendarView === 'planning-grid') {
    if (view.planningGridMode === 'daily') return `Planning Grid - ${dayName}`;
    if (view.planningGridMode === 'weekly') return `Planning Grid - ${weekName}`;
    return `Planning Grid - ${monthName}`;
  }
  if (view.calendarView === 'roles') return `Roles View - ${weekName}`;
  if (view.calendarView === 'total-view') return `Total View - ${monthName}`;
  if (view.calendarDisplayMode === 'at-a-glance') {
    if (view.atAGlanceViewMode === 'daily') return `At-a-Glance - ${dayName}`;
    if (view.atAGlanceViewMode === 'weekly') return `At-a-Glance - ${weekName}`;
    return `At-a-Glance - ${monthName}`;
  }
  return monthName;
}

function ModeButton({ active, onClick, children, activeClass = 'bg-blue-600 text-white', className = '' }) {
  return h('button', {
    type: 'button',
    onClick,
    className: `px-2 md:px-3 py-1 text-xs md:text-sm whitespace-nowrap ${active ? activeClass : 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100'} ${className}`
  }, children);
}

function SchedulerHeader({ view, setView }) {
  const isDaily = view.calendarView === 'planning-grid' && view.planningGridMode === 'daily';
  const isWeekly = view.calendarView === 'planning-grid' && view.planningGridMode === 'weekly';
  const isPlanning = view.calendarView === 'planning-grid';

  const daysInMonth = useMemo(() => {
    const d = cloneDate(view.calendarDate);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }, [view.calendarDate]);

  const dateOptions = useMemo(() => {
    const d = cloneDate(view.calendarDate);
    const y = d.getFullYear();
    const m = d.getMonth();
    const current = toIso(d);
    return Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const date = new Date(y, m, day);
      const dateStr = toIso(date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
      return { value: dateStr, label: `${day} (${dayName})`, selected: dateStr === current };
    });
  }, [view.calendarDate, daysInMonth]);

  const step = (kind) => {
    const next = cloneDate(view.calendarDate);
    if (isDaily) {
      next.setDate(next.getDate() + (kind === 'next' ? 1 : -1));
    } else if (isWeekly || view.calendarView === 'week' || view.calendarView === 'roles') {
      next.setDate(next.getDate() + (kind === 'next' ? 7 : -7));
    } else {
      next.setMonth(next.getMonth() + (kind === 'next' ? 1 : -1), 1);
    }
    setView((v) => ({ ...v, calendarDate: next }));
  };

  return h('div', { className: 'mb-4 space-y-3' },
    h('div', { className: 'flex flex-wrap items-center gap-2 md:gap-4' },
      h('h3', { className: 'text-xl font-semibold text-gray-800 dark:text-gray-200' }, titleForView(view)),
      h('div', { className: 'flex items-center rounded-md border dark:border-gray-600 overflow-x-auto' },
        h(ModeButton, {
          active: view.calendarDisplayMode === 'employee',
          className: 'rounded-l-md',
          onClick: () => setView((v) => ({ ...v, calendarDisplayMode: 'employee' }))
        }, 'Employee'),
        h(ModeButton, {
          active: view.calendarDisplayMode === 'study',
          onClick: () => setView((v) => ({ ...v, calendarDisplayMode: 'study' }))
        }, 'Study'),
        h(ModeButton, {
          active: view.calendarDisplayMode === 'site',
          onClick: () => setView((v) => ({ ...v, calendarDisplayMode: 'site' }))
        }, 'Site'),
        h(ModeButton, {
          active: view.calendarDisplayMode === 'travel',
          onClick: () => setView((v) => ({ ...v, calendarDisplayMode: 'travel' }))
        }, 'Travel'),
        h(ModeButton, {
          active: view.calendarDisplayMode === 'at-a-glance',
          className: isPlanning ? '' : 'rounded-r-md',
          onClick: () => setView((v) => ({ ...v, calendarDisplayMode: 'at-a-glance' }))
        }, 'At-a-Glance')
      ),
      view.calendarDisplayMode === 'at-a-glance'
        ? h('div', { className: 'flex items-center rounded-md border dark:border-gray-600 overflow-x-auto' },
          h(ModeButton, {
            active: view.atAGlanceViewMode === 'daily',
            activeClass: 'bg-green-600 text-white',
            className: 'rounded-l-md',
            onClick: () => setView((v) => ({ ...v, atAGlanceViewMode: 'daily' }))
          }, 'Daily'),
          h(ModeButton, {
            active: view.atAGlanceViewMode === 'weekly',
            activeClass: 'bg-green-600 text-white',
            onClick: () => setView((v) => ({ ...v, atAGlanceViewMode: 'weekly' }))
          }, 'Weekly'),
          h(ModeButton, {
            active: view.atAGlanceViewMode === 'monthly',
            activeClass: 'bg-green-600 text-white',
            className: 'rounded-r-md',
            onClick: () => setView((v) => ({ ...v, atAGlanceViewMode: 'monthly' }))
          }, 'Monthly')
        )
        : null
    ),
    h('div', { className: 'flex flex-wrap items-center justify-between gap-2' },
      h('div', { className: 'flex items-center gap-2' },
        h('div', { className: 'flex items-center rounded-md border dark:border-gray-600 overflow-x-auto' },
          h(ModeButton, {
            active: view.calendarView === 'planning-grid',
            className: 'rounded-l-md',
            onClick: () => setView((v) => ({ ...v, calendarView: 'planning-grid' }))
          }, 'Planning Grid'),
          isPlanning
            ? h(Fragment, null,
              h(ModeButton, {
                active: view.planningGridMode === 'monthly',
                activeClass: 'bg-green-600 text-white',
                onClick: () => setView((v) => ({ ...v, planningGridMode: 'monthly' }))
              }, 'Monthly'),
              h(ModeButton, {
                active: view.planningGridMode === 'weekly',
                activeClass: 'bg-green-600 text-white',
                onClick: () => setView((v) => ({ ...v, planningGridMode: 'weekly' }))
              }, 'Weekly'),
              h(ModeButton, {
                active: view.planningGridMode === 'daily',
                activeClass: 'bg-green-600 text-white',
                className: 'rounded-r-md',
                onClick: () => setView((v) => ({ ...v, planningGridMode: 'daily' }))
              }, 'Daily')
            )
            : null
        ),
        h('div', { className: 'flex items-center rounded-md border dark:border-gray-600 overflow-x-auto' },
          h(ModeButton, {
            active: view.calendarView === 'roles',
            className: 'rounded-l-md',
            onClick: () => setView((v) => ({ ...v, calendarView: 'roles' }))
          }, 'Roles'),
          h(ModeButton, {
            active: view.calendarView === 'total-view',
            onClick: () => setView((v) => ({ ...v, calendarView: 'total-view' }))
          }, 'Total View'),
          h(ModeButton, {
            active: view.calendarView === 'month',
            onClick: () => setView((v) => ({ ...v, calendarView: 'month' }))
          }, 'Month'),
          h(ModeButton, {
            active: view.calendarView === 'week',
            className: 'rounded-r-md',
            onClick: () => setView((v) => ({ ...v, calendarView: 'week' }))
          }, 'Week')
        )
      ),
      h('div', { className: 'flex items-center space-x-2 flex-wrap gap-1' },
        h('button', {
          type: 'button',
          className: 'p-1.5 md:p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200',
          onClick: () => step('prev'),
          'aria-label': 'Previous'
        }, '‹'),
        isDaily
          ? h('select', {
            className: 'p-1.5 border dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 dark:text-white text-xs md:text-sm min-w-[8rem]',
            value: toIso(view.calendarDate),
            onChange: (e) => setView((v) => ({ ...v, calendarDate: cloneDate(e.target.value) }))
          }, ...dateOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)))
          : null,
        h('input', {
          type: 'month',
          className: 'scheduler-month-input p-1.5 border dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 dark:text-white text-xs md:text-sm min-w-[9.5rem]',
          value: monthValue(view.calendarDate),
          onChange: (e) => {
            const [y, m] = String(e.target.value || '').split('-').map(Number);
            if (!y || !m) return;
            const next = cloneDate(view.calendarDate);
            next.setFullYear(y, m - 1, Math.min(next.getDate(), 28));
            setView((v) => ({ ...v, calendarDate: next }));
          }
        }),
        h('button', {
          type: 'button',
          className: 'p-1.5 md:p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200',
          onClick: () => step('next'),
          'aria-label': 'Next'
        }, '›')
      )
    )
  );
}

function ProductionScheduleBody({ view, tick }) {
  const hostRef = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const b = bridge();
    if (!b || typeof b.renderScheduleMarkup !== 'function') {
      setError('Bridge renderScheduleMarkup not ready.');
      return;
    }
    try {
      const markup = b.renderScheduleMarkup({
        calendarView: view.calendarView,
        planningGridMode: view.planningGridMode,
        calendarDisplayMode: view.calendarDisplayMode,
        atAGlanceViewMode: view.atAGlanceViewMode,
        calendarDate: view.calendarDate
      });
      if (hostRef.current) {
        hostRef.current.innerHTML = markup?.bodyHtml || '<div class="p-4 text-sm text-gray-500">No schedule markup returned.</div>';
        if (typeof window.lucide !== 'undefined' && window.lucide.createIcons) {
          try { window.lucide.createIcons({ nodes: [hostRef.current] }); } catch (_) { /* ignore */ }
        }
        // Wire dual-scroll spacers if present (same as production grids)
        const wrappers = hostRef.current.querySelectorAll('.dual-scroll-wrapper');
        wrappers.forEach((wrap) => {
          const top = wrap.querySelector('.dual-scroll-top');
          const main = wrap.querySelector('.dual-scroll-main');
          const spacer = wrap.querySelector('.dual-scroll-spacer');
          if (top && main && spacer) {
            spacer.style.width = `${main.scrollWidth}px`;
            top.onscroll = () => { main.scrollLeft = top.scrollLeft; };
            main.onscroll = () => { top.scrollLeft = main.scrollLeft; };
          }
        });
      }
      setError(null);
    } catch (err) {
      console.error('React Lab schedule render failed', err);
      setError(String(err?.message || err));
    }
  }, [view.calendarView, view.planningGridMode, view.calendarDisplayMode, view.atAGlanceViewMode, view.calendarDate, tick]);

  if (error) {
    return h('div', { className: 'p-4 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm' }, error);
  }
  return h('div', { ref: hostRef, className: 'react-lab-schedule-body' });
}

function LabApp() {
  const [tick, setTick] = useState(0);
  const snap = useMemo(() => {
    const b = bridge();
    if (!b?.getSnapshot) return { error: 'Bridge not ready.' };
    try { return b.getSnapshot(); } catch (err) { return { error: String(err?.message || err) }; }
  }, [tick]);

  const [view, setView] = useState(() => ({
    calendarView: 'planning-grid',
    planningGridMode: 'monthly',
    calendarDisplayMode: 'employee',
    atAGlanceViewMode: 'monthly',
    calendarDate: new Date()
  }));

  // Sync initial view from live scheduler once bridge is ready
  useEffect(() => {
    const b = bridge();
    if (!b?.getSnapshot) return;
    try {
      const s = b.getSnapshot();
      setView((v) => ({
        ...v,
        calendarView: s.calendarView || v.calendarView,
        planningGridMode: s.planningGridMode || v.planningGridMode,
        calendarDisplayMode: s.calendarDisplayMode || v.calendarDisplayMode,
        atAGlanceViewMode: s.atAGlanceViewMode || v.atAGlanceViewMode,
        calendarDate: s.calendarDateIso ? cloneDate(s.calendarDateIso) : v.calendarDate
      }));
    } catch (_) { /* ignore */ }
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return h('div', { className: 'space-y-3' },
    h('div', { className: 'rounded-lg border border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/40 p-3' },
      h('div', { className: 'flex flex-wrap items-start justify-between gap-3' },
        h('div', null,
          h('h2', { className: 'text-lg font-bold text-sky-900 dark:text-sky-100' }, 'React Lab'),
          h('p', { className: 'text-sm text-sky-800/90 dark:text-sky-200/80 mt-0.5 max-w-3xl' },
            'Same Planning Grid Monthly / Weekly / Daily structure as production (plus Month & Week calendars). Body markup is generated by the live CHAOS view builders so layout matches 100%. Read-only sandbox — edits still happen on the Scheduler tab.'
          )
        ),
        h('button', {
          type: 'button',
          className: 'px-3 py-1.5 rounded-md bg-sky-700 text-white text-sm hover:bg-sky-800',
          onClick: refresh
        }, 'Refresh from live state')
      ),
      h('p', { className: 'text-xs text-sky-700 dark:text-sky-300 mt-2' },
        `${snap.monthKey || '—'} · ${snap.events?.length ?? 0} events in live display set · React ${React.version}`
      )
    ),
    snap.error
      ? h('div', { className: 'p-4 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm' }, snap.error)
      : h(Fragment, null,
        h(SchedulerHeader, { view, setView }),
        h(ProductionScheduleBody, { view, tick })
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
