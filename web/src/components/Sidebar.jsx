import { NAV, SOURCES } from "../data";

function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3-3" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconDatabase() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

function IconUser() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

const ICONS = {
  ask: IconSearch,
  rm: IconUsers,
  context: IconUser,
  saved: IconFile,
  sources: IconDatabase,
  history: IconClipboard
};

export default function Sidebar({ nav, onNav, theme, onToggleTheme }) {
  const loaded = SOURCES.filter((s) => s.loaded);
  return (
    <aside className="sidebar" id="sidebarNav" aria-label="Navigation">
      <div className="brand">
        <button
          type="button"
          className="brand-mark"
          aria-pressed={theme === "dark"}
          aria-label="Ora Data Lens, switch theme"
          onClick={onToggleTheme}
        >
          <img className="brand-lockup" src="/img/logo-lockup.png" width="200" height="82" alt="" />
          <img className="brand-icon" src="/img/logo-mark.png" width="40" height="40" alt="" />
        </button>
        <div className="brand-tag">The ophthalmology research company</div>
      </div>

      <nav className="nav" aria-label="Data Lens">
        <div className="nav-label">Data Lens</div>
        {NAV.map((n) => {
          const Icon = ICONS[n.key] || IconSearch;
          const disabled = n.key !== "ask";
          return (
            <button
              key={n.key}
              type="button"
              className={`nav-btn${nav === n.key ? " active" : ""}`}
              disabled={disabled}
              title={disabled ? "Not in this React spike — Ask only" : undefined}
              onClick={() => onNav(n.key)}
            >
              <Icon />
              <span>{n.label}</span>
            </button>
          );
        })}
      </nav>

      <details className="sources" open>
        <summary className="sources-head">
          <div className="eyebrow">Data sources</div>
          <div className="sources-summary">{loaded.map((s) => s.name).join(" · ")}</div>
        </summary>
        <div className="source-list">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`source-card ${s.loaded ? "scope" : "dim"}`}
              disabled={!s.loaded}
            >
              <span className="source-dot" style={{ background: s.loaded ? "var(--ora-teal-400)" : "var(--ora-gray-400)" }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="source-top">
                  <span className="source-name">{s.name}</span>
                  <span className="source-status">{s.loaded ? "Ready" : "Off"}</span>
                </span>
                <span className="source-cat">{s.cat}</span>
                <span className="source-scope">{s.scope}</span>
              </span>
            </button>
          ))}
        </div>
      </details>

      <div className="sidebar-foot">
        <div className="scope-note">React spike · Ask page only · CSS from production</div>
      </div>
    </aside>
  );
}
