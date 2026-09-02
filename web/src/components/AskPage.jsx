import { useState } from "react";
import { PURPOSES, SOURCES, SUGGESTIONS } from "../data";

export default function AskPage({ purpose, onPurpose }) {
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | thinking | answered | error
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState("");

  const loadedCount = SOURCES.filter((s) => s.loaded).length;

  async function runAsk(text) {
    const q = String(text || draft).trim();
    if (!q) return;
    setDraft("");
    setAsked(q);
    setPhase("thinking");
    setError("");
    setAnswer(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, purpose })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Ask failed (${res.status})`);
      }
      setAnswer(body.answer || body);
      setPhase("answered");
    } catch (err) {
      setError(
        err.message ||
          "API not reachable. Start `func start` in /api (proxy → :7071), or this is UI-only."
      );
      setPhase("error");
    }
  }

  return (
    <div className="stack">
      <div className="ask-box">
        <textarea
          rows={3}
          value={draft}
          placeholder="Ask from the loaded Cosmos sources — or pick a purpose above."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              runAsk();
            }
          }}
        />
        <div className="ask-bar">
          <div className="ask-meta">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
            </svg>
            <span>
              {loadedCount} of {SOURCES.length} sources in scope
            </span>
          </div>
          <button type="button" className="btn btn-accent" onClick={() => runAsk()}>
            Ask
          </button>
        </div>
      </div>

      {phase === "idle" && (
        <div>
          <div className="suggest-head">Start from</div>
          <div className="suggest-list" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {SUGGESTIONS.map((text) => (
              <button key={text} type="button" className="suggest" onClick={() => runAsk(text)}>
                <span className="suggest-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M20 20l-3-3" />
                  </svg>
                </span>
                <span>
                  <span className="suggest-text">{text}</span>
                  <span className="suggest-needs">React spike · hits /api/ask when Functions are up</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {phase === "thinking" && (
        <div className="briefing">
          <div className="briefing-note">Reading sources…</div>
          <div className="skeleton" style={{ height: 12, width: "72%", marginTop: 12 }} />
          <div className="skeleton" style={{ height: 12, width: "94%", marginTop: 8 }} />
          <div className="skeleton" style={{ height: 12, width: "48%", marginTop: 8 }} />
        </div>
      )}

      {phase === "error" && (
        <div className="briefing">
          <p style={{ margin: "4px 0 0", fontSize: 15, fontWeight: 500, color: "var(--text-heading)" }}>{asked}</p>
          <div className="briefing-note">{error}</div>
          <button type="button" className="btn btn-ghost" onClick={() => setPhase("idle")}>
            Back
          </button>
        </div>
      )}

      {phase === "answered" && answer && (
        <div className="briefing">
          <p style={{ margin: "4px 0 12px", fontSize: 15, fontWeight: 500, color: "var(--text-heading)" }}>{asked}</p>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: "var(--text-body)" }}>
            {answer.summary || answer.text || "Answer returned."}
          </p>
          {answer.chartTitle && <div className="briefing-chart-title">{answer.chartTitle}</div>}
          {answer.chartNote && <div className="briefing-note">{answer.chartNote}</div>}
          {Array.isArray(answer.rows) && answer.rows.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {(answer.cols || []).map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {answer.rows.slice(0, 12).map((row, i) => (
                    <tr key={i}>
                      {(Array.isArray(row) ? row : [row]).map((cell, j) => (
                        <td key={j}>{String(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setPhase("idle")}>
              New question
            </button>
          </div>
        </div>
      )}

      <div className="purpose" role="tablist" aria-label="Purpose" style={{ display: "none" }}>
        {PURPOSES.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`purpose-btn${purpose === p.id ? " active" : ""}`}
            onClick={() => onPurpose(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
