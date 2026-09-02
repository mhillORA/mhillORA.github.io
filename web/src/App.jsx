import { useEffect, useState } from "react";
import AskPage from "./components/AskPage";
import Sidebar from "./components/Sidebar";
import { PURPOSES } from "./data";
import "./styles.css";

function loadTheme() {
  try {
    const raw = localStorage.getItem("odl.theme");
    const t = raw ? JSON.parse(raw) : null;
    if (t === "dark" || t === "light") return t;
  } catch (_) {}
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [nav, setNav] = useState("ask");
  const [purpose, setPurpose] = useState("clinops");
  const [theme, setTheme] = useState(loadTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("odl.theme", JSON.stringify(theme));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#001123" : "#052c49");
  }, [theme]);

  const purposeMeta = PURPOSES.find((p) => p.id === purpose);

  return (
    <div className="app" id="appRoot">
      <Sidebar
        nav={nav}
        onNav={setNav}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>Ask your data</h1>
            <span className="scope-line">
              React spike · {purposeMeta?.label || "ClinOps"} · same CSS as production
            </span>
          </div>
          <div className="purpose" role="tablist" aria-label="Purpose">
            {PURPOSES.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`purpose-btn${purpose === p.id ? " active" : ""}`}
                onClick={() => setPurpose(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="topbar-actions">
            <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>
              New question
            </button>
            <button type="button" className="btn btn-secondary" disabled title="Not in spike">
              Save this view
            </button>
          </div>
        </header>

        <div className="scroll">
          {nav === "ask" ? (
            <AskPage purpose={purpose} onPurpose={setPurpose} />
          ) : (
            <div className="briefing-note">Only Ask is ported in this spike.</div>
          )}
        </div>
      </main>
    </div>
  );
}
