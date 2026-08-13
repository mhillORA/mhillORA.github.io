const NUM_FIELDS = [
  "actual_gm_pct_prior_month",
  "budgeted_gm_pct",
  "gm_pct_variance",
  "projected_eos_gm_pct_prior_month",
  "cost_per_billable_hr_actual",
  "cost_per_billable_hr_budgeted"
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r") continue;
    else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || "").trim());
  return rows
    .slice(1)
    .filter((r) => r.some((x) => String(x || "").trim()))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => {
        o[h] = r[i] == null ? "" : String(r[i]).trim();
      });
      return o;
    });
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function numOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function docId(row) {
  const num = String(row.project_number || "").trim();
  const name = slug(row.project_name);
  if (!num || !name) return null;
  return `${num}__${name}`;
}

function toDoc(row, syncedAt, blobPath) {
  const id = docId(row);
  if (!id) return null;
  const doc = {
    id,
    project_number: String(row.project_number).trim(),
    docType: "lens_ns_project",
    project_name: row.project_name || "",
    project_manager: row.project_manager || "",
    customer_name: row.customer_name || "",
    project_status: row.project_status || "",
    service_line: row.service_line || "",
    change_order_status: row.change_order_status || null,
    sourceBlob: blobPath,
    syncedAt
  };
  for (const f of NUM_FIELDS) doc[f] = numOrNull(row[f]);
  return doc;
}

module.exports = { parseCsv, toDoc };
