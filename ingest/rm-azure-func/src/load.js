const XLSX = require("xlsx");
const JSZip = require("jszip");
const { BlobServiceClient } = require("@azure/storage-blob");
const { SHEETS, DQ_SHEETS, SKIP_SHEETS, PRODUCTION_DOMAIN_ID } = require("./map");
const { getDatabase, replaceSheet, replaceDocs, replaceDq, writeRun } = require("./write");
const { docsFromCsvText, classifyCsvName, WORKITEM_SPEC } = require("./csvStaffing");

const BLOB_CONTAINER = "insightsrm";
/** landing/2026/08/17/1800/file.xlsx — time folder optional: landing/2026/8/17/file.xlsx also ok */
const LANDING_RE = /^landing\/\d{4}\/\d{1,2}\/\d{1,2}(?:\/[^/]+)?\/[^/]+$/i;

function storageAccountHint(conn) {
  const m = String(conn || "").match(/AccountName=([^;]+)/i);
  return m ? m[1] : "unknown";
}

async function sampleBlobNames(limit = 20) {
  const container = blobClient();
  const names = [];
  for await (const blob of container.listBlobsFlat()) {
    names.push(blob.name);
    if (names.length >= limit) break;
  }
  return names;
}

function env(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return v || fallback;
}

function assertStorageConn(conn) {
  if (!conn) throw new Error("INSIGHTSRM_STORAGE is empty on this Function App");
  if (/documents\.azure\.com/i.test(conn) || /AccountEndpoint=https:\/\/.*cosmos/i.test(conn)) {
    throw new Error("INSIGHTSRM_STORAGE must be a Storage connection string (container insightsrm), not Cosmos and not NETSUITE_STORAGE");
  }
}

function blobClient() {
  const conn = env("INSIGHTSRM_STORAGE");
  assertStorageConn(conn);
  return BlobServiceClient.fromConnectionString(conn).getContainerClient(BLOB_CONTAINER);
}

function baseName(path) {
  return String(path || "").split("/").pop() || "";
}

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
}

function parseWorkbook(buffer) {
  return XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
}

async function listLanding() {
  const container = blobClient();
  const files = { xlsx: [], zip: [], csv: [] };
  for await (const blob of container.listBlobsFlat({ prefix: "landing/" })) {
    const name = blob.name || "";
    if (!LANDING_RE.test(name)) continue;
    const base = baseName(name);
    if (base.startsWith("~$")) continue;
    if (/\.xlsx$/i.test(base)) files.xlsx.push(name);
    else if (/\.zip$/i.test(base)) files.zip.push(name);
    else if (/\.csv$/i.test(base) && classifyCsvName(base)) files.csv.push(name);
  }
  files.xlsx.sort();
  files.zip.sort();
  files.csv.sort();
  return files;
}

async function download(path) {
  const buf = await blobClient().getBlobClient(path).downloadToBuffer();
  return buf;
}

async function loadWorkbookToCosmos(buffer, blobPath, log) {
  const syncedAt = new Date().toISOString();
  const startedAt = syncedAt;
  const wb = parseWorkbook(buffer);
  const present = wb.SheetNames || [];
  log(`InsightsRM workbook ${blobPath} sheets=${present.join(",")}`);

  const database = await getDatabase();
  const counts = {};
  for (const def of SHEETS) {
    if (SKIP_SHEETS.has(def.sheet)) continue;
    const rows = sheetRows(wb, def.sheet);
    const docs = require("./map").toDocs(def, rows, syncedAt, blobPath);
    const result = await replaceSheet(database, def, docs);
    counts[def.container] = result;
    log(`${def.sheet} → ${def.container} upserted=${result.upserted} deleted=${result.deleted}`);
  }

  const { toDqDocs } = require("./map");
  const dqBySheet = {};
  for (const sheet of DQ_SHEETS) {
    dqBySheet[sheet] = toDqDocs(sheet, sheetRows(wb, sheet), syncedAt, blobPath);
  }
  counts.lens_rm_dq = await replaceDq(database, dqBySheet);
  log(`DQ → lens_rm_dq upserted=${counts.lens_rm_dq.upserted} deleted=${counts.lens_rm_dq.deleted}`);

  const finishedAt = new Date().toISOString();
  const run = await writeIngestRun(database, {
    landing: "xlsx",
    sourceBlob: blobPath,
    startedAt,
    presentSheets: present,
    skippedSheets: [...SKIP_SHEETS],
    counts
  });
  return { blob: blobPath, counts, runId: run.id };
}

async function writeIngestRun(database, extra) {
  const finishedAt = extra.finishedAt || new Date().toISOString();
  const runDate = finishedAt.slice(0, 10);
  const run = {
    id: `${runDate}_${finishedAt.slice(11, 19).replace(/:/g, "")}_${extra.landing || "rm"}`,
    runDate,
    docType: "lens_rm_run",
    source: "insightsrm",
    datasetKind: "actual",
    untilGold: true,
    productionDomainId: PRODUCTION_DOMAIN_ID,
    startedAt: extra.startedAt,
    finishedAt,
    ok: true,
    ...extra,
    finishedAt
  };
  await writeRun(database, run);
  return run;
}

function mergeStaffing(into, parsed) {
  if (!parsed || !parsed.docs.length) return;
  const key = parsed.spec.container;
  if (!into[key]) into[key] = { spec: parsed.spec, docs: [], files: [], kinds: [] };
  if (parsed.kind === "workitem-role" && into[key].kinds.includes("workitem")) return;
  if (parsed.kind === "workitem" && into[key].kinds.includes("workitem-role")) {
    into[key].docs = parsed.docs;
    into[key].kinds = ["workitem"];
    into[key].files.push(parsed.file);
    return;
  }
  into[key].docs.push(...parsed.docs);
  into[key].kinds.push(parsed.kind);
  into[key].files.push(parsed.file);
}

async function csvPartsFromZip(buffer, blobPath) {
  const zip = await JSZip.loadAsync(buffer);
  const parts = [];
  const names = Object.keys(zip.files).sort();
  for (const name of names) {
    const f = zip.files[name];
    if (f.dir) continue;
    const base = baseName(name);
    if (!classifyCsvName(base)) continue;
    const text = await f.async("string");
    parts.push({ filename: base, text, blobPath: `${blobPath}#${base}` });
  }
  return parts;
}

async function loadStaffingParts(parts, log) {
  const startedAt = new Date().toISOString();
  const grouped = {};
  for (const part of parts) {
    const parsed = docsFromCsvText(part.filename, part.text, part.blobPath, startedAt);
    parsed.file = part.blobPath;
    if (!parsed.spec) {
      log(`skip unknown csv ${part.filename}`);
      continue;
    }
    if (!parsed.docs.length) {
      log(`skip ${part.filename} (no rows)`);
      continue;
    }
    mergeStaffing(grouped, parsed);
    log(`${part.filename} → ${parsed.spec.container} ${parsed.docs.length} docs`);
  }
  const keys = Object.keys(grouped);
  if (!keys.length) throw new Error("RM csv/zip had no classified rows (staffing grids, roster, assignments, or schedule)");

  const database = await getDatabase();
  const counts = {};
  for (const key of keys) {
    const g = grouped[key];
    counts[key] = await replaceDocs(database, g.spec, g.docs);
    log(`${key} upserted=${counts[key].upserted} deleted=${counts[key].deleted}`);
  }
  const blobs = [...new Set(parts.map((p) => p.blobPath.split("#")[0]))];
  const run = await writeIngestRun(database, {
    landing: "csv",
    sourceBlob: blobs.join(";"),
    startedAt,
    files: parts.map((p) => p.filename),
    counts
  });
  return { blobs, counts, runId: run.id };
}

async function loadStaffingBuffer(buffer, blobPath, filename, log) {
  const base = filename || baseName(blobPath);
  if (/\.zip$/i.test(base)) {
    const parts = await csvPartsFromZip(buffer, blobPath);
    if (!parts.length) throw new Error(`Zip ${blobPath} has no RM csv (Staffing-By-*, RM-employees, RM-assignments, RM-Sch)`);
    return loadStaffingParts(parts, log);
  }
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  return loadStaffingParts([{ filename: base, text, blobPath }], log);
}

function canonKind(kind) {
  return kind === "workitem-role" ? "workitem" : kind;
}

async function collectCsvParts(files) {
  const latest = {};
  function consider(part, sortKey) {
    const rawKind = classifyCsvName(part.filename);
    if (!rawKind) return;
    const kind = canonKind(rawKind);
    if (rawKind === "workitem-role" && latest.workitem && latest.workitem.rawKind === "workitem") return;
    if (!latest[kind] || sortKey >= latest[kind].sortKey) {
      latest[kind] = { ...part, kind: rawKind, rawKind, sortKey };
    }
  }
  for (const zipPath of files.zip) {
    const buffer = await download(zipPath);
    const parts = await csvPartsFromZip(buffer, zipPath);
    for (const part of parts) consider(part, zipPath);
  }
  for (const csvPath of files.csv) {
    const buffer = await download(csvPath);
    consider(
      { filename: baseName(csvPath), text: buffer.toString("utf8"), blobPath: csvPath },
      csvPath
    );
  }
  return Object.values(latest);
}

async function runRmIngest(log) {
  const files = await listLanding();
  const out = { xlsx: null, csv: null };
  if (files.xlsx.length) {
    const blobPath = files.xlsx[files.xlsx.length - 1];
    const buffer = await download(blobPath);
    out.xlsx = await loadWorkbookToCosmos(buffer, blobPath, log);
  }
  const parts = await collectCsvParts(files);
  if (parts.length) {
    out.csv = await loadStaffingParts(parts, log);
  }
  if (!out.xlsx && !out.csv) {
    const seen = await sampleBlobNames(20);
    const acct = storageAccountHint(env("INSIGHTSRM_STORAGE"));
    throw new Error(
      "No RM files matched landing/yyyy/MM/dd/(optional-time)/filename in container insightsrm. " +
        `Storage account from INSIGHTSRM_STORAGE: ${acct}. ` +
        "Upload example: landing/2026/08/17/1800/Ora_Resource_Model_1.xlsx (not container root, not netsuite). " +
        (seen.length
          ? `Blobs in this container (first ${seen.length}): ${seen.join(" | ")}`
          : "Container insightsrm is empty — wrong storage account or wrong container name.")
    );
  }
  return out;
}

module.exports = {
  BLOB_CONTAINER,
  WORKITEM_SPEC,
  listLanding,
  loadWorkbookToCosmos,
  loadStaffingBuffer,
  runRmIngest,
  assertStorageConn
};
