const { getDb, LENS } = require("./cosmos");
const { docIdFor } = require("./principal");
const { loadEntraProfile } = require("./graph");

/**
 * Full context lives here (role playbooks). Cosmos lens_user_prefs is a
 * secondary reference: which playbook this Entra user chose + extras.
 * Ask still reads warehouse numbers from other containers; this only frames them.
 */

const ROLE_PLAYBOOKS = {
  director: {
    key: "director",
    label: "Director",
    primary: "portfolio",
    then: ["exceptions", "projects"],
    instruction:
      "Give a higher-level overview. Lead with portfolio and exceptions (under GM, missing data, at-risk). Do not walk person-by-person unless asked."
  },
  manager: {
    key: "manager",
    label: "Manager",
    primary: "direct_reports",
    then: ["their_projects"],
    instruction:
      "Show their direct reports first, then the projects those people sit on. Keep the team as the spine of the answer."
  },
  pm: {
    key: "pm",
    label: "Project manager",
    primary: "project",
    then: ["employees"],
    instruction:
      "The project is the main point, then the employees on it. Lead with project status, GM, enrollment; names and staffing come second."
  },
  exec: {
    key: "exec",
    label: "Executive",
    primary: "org",
    then: ["exceptions"],
    instruction:
      "Org-level KPIs and exceptions only. Skip site-level and person-level unless the question names them."
  },
  analyst: {
    key: "analyst",
    label: "Analyst",
    primary: "grain",
    then: ["missing"],
    instruction:
      "Keep full grain. Call out missing vs known. Do not roll up away blanks."
  }
};

const DOC_TYPE = "lens_user_pref";
const MAX_EXTRAS = 20;
const MAX_EXTRA_LEN = 400;
const MAX_NOTES = 2000;

function playbookFor(roleKey) {
  return ROLE_PLAYBOOKS[roleKey] || null;
}

function sanitizeExtras(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, MAX_EXTRAS)) {
    const text = String(item && (item.text || item) || "").trim().slice(0, MAX_EXTRA_LEN);
    if (!text) continue;
    const id = String(item && item.id ? item.id : `x${out.length + 1}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
    out.push({ id: id || `x${out.length + 1}`, text });
  }
  return out;
}

function emptyPref(principal) {
  return {
    entraId: principal.entraId,
    email: principal.email || "",
    displayName: principal.displayName || "",
    roleKey: "",
    notes: "",
    extras: [],
    exists: false
  };
}

function publicPref(doc, principal, entra) {
  const override = Boolean(doc && doc.roleOverride && ROLE_PLAYBOOKS[doc.roleKey]);
  const fromEntra = entra && entra.ok ? entra.suggestedRoleKey : "";
  const saved = doc && ROLE_PLAYBOOKS[doc.roleKey] ? doc.roleKey : "";
  const roleKey = override ? saved : fromEntra || saved;
  const playbook = playbookFor(roleKey);
  const roleSource = override ? "override" : fromEntra && roleKey === fromEntra ? "entra" : saved ? "saved" : "";
  return {
    entraId: (doc && doc.entraId) || principal.entraId,
    email: (entra && entra.email) || (doc && doc.email) || principal.email || "",
    displayName: (entra && entra.displayName) || (doc && doc.displayName) || principal.displayName || "",
    roleKey,
    roleLabel: playbook ? playbook.label : "",
    roleSource,
    roleOverride: override,
    notes: doc && doc.notes ? String(doc.notes) : "",
    extras: sanitizeExtras(doc && doc.extras),
    updatedAt: (doc && doc.updatedAt) || null,
    exists: Boolean(doc && doc.id),
    entra: entra
      ? {
          ok: Boolean(entra.ok),
          jobTitle: entra.jobTitle || "",
          department: entra.department || "",
          suggestedRoleKey: entra.suggestedRoleKey || "",
          manager: entra.manager || null,
          reports: entra.reports || [],
          error: entra.error || ""
        }
      : null,
    playbook: playbook
      ? {
          key: playbook.key,
          label: playbook.label,
          primary: playbook.primary,
          then: playbook.then,
          instruction: playbook.instruction
        }
      : null,
    playbooks: Object.values(ROLE_PLAYBOOKS).map((p) => ({
      key: p.key,
      label: p.label,
      primary: p.primary,
      then: p.then,
      instruction: p.instruction
    }))
  };
}

async function prefsContainer() {
  const db = getDb();
  const { container } = await db.containers.createIfNotExists({
    id: LENS.userPrefs,
    partitionKey: { paths: ["/entraId"] }
  });
  return container;
}

async function getPrefDoc(principal) {
  const id = docIdFor(principal);
  if (!id) return null;
  const container = await prefsContainer();
  try {
    const { resource } = await container.item(id, principal.entraId).read();
    return resource || null;
  } catch (err) {
    if (err && (err.code === 404 || err.statusCode === 404)) return null;
    throw err;
  }
}

async function getViewerContext(principal) {
  if (!principal) return { exists: false, playbook: null, extras: [], notes: "" };
  const [doc, entra] = await Promise.all([getPrefDoc(principal), loadEntraProfile(principal.entraId)]);
  return publicPref(doc, principal, entra);
}

async function upsertPref(principal, patch) {
  const id = docIdFor(principal);
  if (!id) throw new Error("signed-in Entra identity required");
  const existing = (await getPrefDoc(principal)) || {};
  let roleKey = patch.roleKey != null ? String(patch.roleKey).trim() : existing.roleKey || "";
  if (roleKey && !ROLE_PLAYBOOKS[roleKey]) {
    throw new Error(`unknown roleKey "${roleKey}"`);
  }
  let roleOverride = existing.roleOverride === true;
  if (patch.useEntra === true) {
    roleOverride = false;
    roleKey = "";
  } else if (patch.roleKey != null && patch.roleKey !== "") {
    roleOverride = true;
  }
  const notes =
    patch.notes != null ? String(patch.notes).trim().slice(0, MAX_NOTES) : existing.notes || "";
  const extras = patch.extras != null ? sanitizeExtras(patch.extras) : sanitizeExtras(existing.extras);
  const doc = {
    id,
    entraId: principal.entraId,
    docType: DOC_TYPE,
    email: principal.email || existing.email || "",
    displayName: principal.displayName || existing.displayName || "",
    roleKey,
    roleOverride,
    notes,
    extras,
    updatedAt: new Date().toISOString()
  };
  const container = await prefsContainer();
  await container.items.upsert(doc);
  const entra = await loadEntraProfile(principal.entraId);
  return publicPref(doc, principal, entra);
}

async function deletePref(principal) {
  const id = docIdFor(principal);
  if (!id) throw new Error("signed-in Entra identity required");
  const container = await prefsContainer();
  try {
    await container.item(id, principal.entraId).delete();
  } catch (err) {
    if (!(err && (err.code === 404 || err.statusCode === 404))) throw err;
  }
  const entra = await loadEntraProfile(principal.entraId);
  return publicPref(null, principal, entra);
}

function foundryViewerSlice(viewer) {
  if (
    !viewer ||
    (!viewer.roleKey &&
      !(viewer.extras || []).length &&
      !viewer.notes &&
      !(viewer.entra && viewer.entra.jobTitle))
  ) {
    return null;
  }
  return {
    role: viewer.roleLabel || viewer.roleKey || "",
    primary: viewer.playbook ? viewer.playbook.primary : "",
    then: viewer.playbook ? viewer.playbook.then : [],
    instruction: viewer.playbook ? viewer.playbook.instruction : "",
    notes: viewer.notes || "",
    extras: (viewer.extras || []).map((e) => e.text),
    jobTitle: viewer.entra && viewer.entra.jobTitle ? viewer.entra.jobTitle : "",
    department: viewer.entra && viewer.entra.department ? viewer.entra.department : "",
    roleSource: viewer.roleSource || "",
    manager: viewer.entra && viewer.entra.manager ? viewer.entra.manager.displayName : "",
    reports: (viewer.entra && viewer.entra.reports ? viewer.entra.reports : []).map((r) => r.displayName)
  };
}

module.exports = {
  ROLE_PLAYBOOKS,
  playbookFor,
  publicPref,
  emptyPref,
  getViewerContext,
  upsertPref,
  deletePref,
  foundryViewerSlice
};
