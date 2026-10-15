/**
 * Global site-survey welcome cards (Experienced with Ora / New to Ora).
 * Stored once in Cosmos; hardcoded defaults remain the public fallback.
 */
const WELCOME_COPY_ID = 'survey-welcome-copy';
const DEFINITIONS = 'site-survey-definitions';

const DEFAULT_WELCOME_COPY = {
    experienced: {
        title: 'Sites experienced with Ora',
        body:
            "Welcome back — and thank you for your continued partnership. Because your site has worked with Ora before, we've already completed most of this form for you using information from your prior studies. Simply review what we have on file, confirm it's still accurate, and answer a few study-specific questions at the end.",
        durationNote: 'This should take about 15 minutes.',
    },
    newToOra: {
        title: "New to Ora? Welcome — we're glad you're here.",
        body:
            "Thank you for your interest in partnering with Ora on this study. As you complete this profile, we'll store your information securely so that future feasibility surveys are faster and more streamlined — many of these questions will only need to be answered once. We look forward to building a lasting partnership with your site.",
        durationNote: 'This should take about 30 minutes.',
    },
};

const TITLE_MAX = 160;
const BODY_MAX = 2000;
const DURATION_MAX = 120;

/** Short in-memory cache for public survey loads (cold-start friendly). */
let _cache = { at: 0, doc: null };
const CACHE_MS = 60_000;

function trimStr(v, max) {
    const s = String(v ?? '').trim();
    if (!s) return '';
    return s.slice(0, max);
}

function normalizeCard(raw, fallback) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    const title = trimStr(src.title, TITLE_MAX) || trimStr(fb.title, TITLE_MAX);
    const body = trimStr(src.body, BODY_MAX) || trimStr(fb.body, BODY_MAX);
    const durationNote = trimStr(src.durationNote, DURATION_MAX) || trimStr(fb.durationNote, DURATION_MAX);
    return { title, body, durationNote };
}

function normalizeWelcomeCopy(doc) {
    const d = doc && typeof doc === 'object' ? doc : {};
    return {
        id: WELCOME_COPY_ID,
        type: 'welcomeCopy',
        experienced: normalizeCard(d.experienced, DEFAULT_WELCOME_COPY.experienced),
        newToOra: normalizeCard(d.newToOra, DEFAULT_WELCOME_COPY.newToOra),
        updatedAt: d.updatedAt || null,
        updatedBy: d.updatedBy || null,
    };
}

function publicWelcomeCopy(doc) {
    const n = normalizeWelcomeCopy(doc);
    return {
        experienced: { ...n.experienced },
        newToOra: { ...n.newToOra },
        updatedAt: n.updatedAt,
    };
}

function invalidateWelcomeCopyCache() {
    _cache = { at: 0, doc: null };
}

async function readWelcomeCopyDoc(getContainer, { bypassCache = false } = {}) {
    const now = Date.now();
    if (!bypassCache && _cache.doc && now - _cache.at < CACHE_MS) {
        return _cache.doc;
    }
    try {
        const { resource } = await getContainer(DEFINITIONS).item(WELCOME_COPY_ID, WELCOME_COPY_ID).read();
        if (resource && resource.type === 'welcomeCopy') {
            const normalized = normalizeWelcomeCopy(resource);
            _cache = { at: now, doc: normalized };
            return normalized;
        }
    } catch (_) {
        /* missing doc → defaults */
    }
    const fallback = normalizeWelcomeCopy(DEFAULT_WELCOME_COPY);
    _cache = { at: now, doc: fallback };
    return fallback;
}

async function upsertWelcomeCopyDoc(getContainer, body, { operator } = {}) {
    const incoming = body && typeof body === 'object' ? body : {};
    const now = new Date().toISOString();
    let previous = null;
    try {
        const { resource } = await getContainer(DEFINITIONS).item(WELCOME_COPY_ID, WELCOME_COPY_ID).read();
        previous = resource;
    } catch (_) {}

    const merged = normalizeWelcomeCopy({
        ...(previous || {}),
        experienced: incoming.experienced != null ? incoming.experienced : previous?.experienced,
        newToOra: incoming.newToOra != null ? incoming.newToOra : previous?.newToOra,
    });

    const doc = {
        id: WELCOME_COPY_ID,
        type: 'welcomeCopy',
        experienced: merged.experienced,
        newToOra: merged.newToOra,
        updatedAt: now,
        updatedBy: operator || previous?.updatedBy || null,
        createdAt: previous?.createdAt || now,
    };

    const c = getContainer(DEFINITIONS);
    if (previous) {
        const { resource } = await c.item(WELCOME_COPY_ID, WELCOME_COPY_ID).replace(doc);
        invalidateWelcomeCopyCache();
        return normalizeWelcomeCopy(resource || doc);
    }
    const { resource } = await c.items.create(doc);
    invalidateWelcomeCopyCache();
    return normalizeWelcomeCopy(resource || doc);
}

async function ensureWelcomeCopySeeded(getContainer) {
    try {
        await getContainer(DEFINITIONS).item(WELCOME_COPY_ID, WELCOME_COPY_ID).read();
        return false;
    } catch (_) {
        await upsertWelcomeCopyDoc(getContainer, DEFAULT_WELCOME_COPY, { operator: 'system-seed' });
        return true;
    }
}

module.exports = {
    WELCOME_COPY_ID,
    DEFAULT_WELCOME_COPY,
    normalizeWelcomeCopy,
    publicWelcomeCopy,
    readWelcomeCopyDoc,
    upsertWelcomeCopyDoc,
    ensureWelcomeCopySeeded,
    invalidateWelcomeCopyCache,
};
