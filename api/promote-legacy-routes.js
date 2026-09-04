/**
 * Promote legacy-sites → live `sites` (ARTEMIS only).
 *
 * CHAOS / NASA SAFETY (do not weaken):
 * - Never touch schedules, patients, events, crcs, studies.siteIds, or NASA notify paths.
 * - Matched live sites: ONLY write link metadata on legacy-sites (+ optional legacySiteIds on sites).
 *   Do NOT overwrite live name, staff, studyIds, or any field Chaos scheduling uses.
 * - Unmatched: create a minimal sites row (inert until ops schedules against it).
 * - Never delete legacy docs; never retarget survey/outcome partition keys here.
 */
const LEGACY_SITES = 'legacy-sites';
const LIVE_SITES = 'sites';

function corsHeaders() {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Artemis-Operator',
    };
}

function normSiteName(s) {
    return String(s ?? '')
        .toLowerCase()
        .replace(/\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc)\b/gi, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function slugify(name) {
    return (
        String(name || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'unknown'
    );
}

function readHeader(request, name) {
    try {
        if (request.headers && typeof request.headers.get === 'function') {
            return request.headers.get(name) || request.headers.get(name.toLowerCase());
        }
        if (request.headers) return request.headers[name] || request.headers[name.toLowerCase()];
    } catch (_) {}
    return null;
}

function buildLiveSiteFromLegacy(legacy, generateId) {
    const now = new Date().toISOString();
    const name = String(legacy.name || '').trim() || 'Promoted site';
    return {
        id: generateId(),
        name,
        status: 'Active',
        address: legacy.address || legacy.street || '',
        city: legacy.city || '',
        state: legacy.state || '',
        zip: legacy.zip || legacy.postalCode || '',
        pi: legacy.pi || legacy.piName || '',
        piEmail: legacy.piEmail || '',
        siteCoordinator: legacy.siteCoordinator || legacy.coordinator || '',
        siteCoordinatorEmail: legacy.siteCoordinatorEmail || legacy.coordinatorEmail || '',
        notes: legacy.notes || '',
        source: 'promoted-from-legacy',
        promotedFromLegacySiteId: legacy.id,
        legacySiteIds: [legacy.id],
        createdAt: now,
        updatedAt: now,
        // Explicitly omit studyIds / scheduling fields — Chaos must not get fake memberships
    };
}

function registerPromoteLegacyRoutes(app, deps) {
    const { getContainer, handleError, generateId } = deps;

    app.http('legacySitesPromote', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'legacy-sites/promote',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                const body = await request.json().catch(() => ({}));
                const dryRun = body?.dryRun === true || body?.mode === 'dryRun';
                const operator =
                    body?.operator ||
                    readHeader(request, 'X-Artemis-Operator') ||
                    'unknown';

                const legacyC = getContainer(LEGACY_SITES);
                const liveC = getContainer(LIVE_SITES);

                let legacySites = [];
                if (Array.isArray(body?.legacySiteIds) && body.legacySiteIds.length) {
                    for (const id of body.legacySiteIds.map(String)) {
                        try {
                            const read = await legacyC.item(id, id).read();
                            if (read.resource) legacySites.push(read.resource);
                            else {
                                legacySites.push({ id, _missing: true });
                            }
                        } catch (_) {
                            legacySites.push({ id, _missing: true });
                        }
                    }
                } else {
                    const { resources } = await legacyC.items
                        .query({ query: 'SELECT * FROM c' }, { enableCrossPartitionQuery: true })
                        .fetchAll();
                    legacySites = resources || [];
                }

                const { resources: liveRows } = await liveC.items
                    .query(
                        { query: 'SELECT c.id, c.name, c.legacySiteIds, c.promotedFromLegacySiteId FROM c' },
                        { enableCrossPartitionQuery: true }
                    )
                    .fetchAll();
                const liveSites = liveRows || [];

                const byExact = new Map();
                const byNorm = new Map();
                for (const s of liveSites) {
                    if (!s?.id || !s?.name) continue;
                    const exact = String(s.name).trim().toLowerCase();
                    if (exact && !byExact.has(exact)) byExact.set(exact, []);
                    if (exact) byExact.get(exact).push(s);
                    const norm = normSiteName(s.name);
                    if (norm && !byNorm.has(norm)) byNorm.set(norm, []);
                    if (norm) byNorm.get(norm).push(s);
                }

                const results = [];
                const now = new Date().toISOString();

                for (const legacy of legacySites) {
                    if (legacy._missing) {
                        results.push({
                            legacySiteId: legacy.id,
                            legacyName: null,
                            action: 'error',
                            reason: 'Legacy site not found',
                        });
                        continue;
                    }

                    const legacyName = legacy.name || legacy.id;

                    // Already linked
                    if (legacy.linkedArtemisSiteId) {
                        let liveName = null;
                        try {
                            const read = await liveC
                                .item(legacy.linkedArtemisSiteId, legacy.linkedArtemisSiteId)
                                .read();
                            liveName = read.resource?.name || null;
                        } catch (_) {}
                        results.push({
                            legacySiteId: legacy.id,
                            legacyName,
                            action: 'skipped',
                            liveSiteId: legacy.linkedArtemisSiteId,
                            liveSiteName: liveName,
                            reason: 'Already linked',
                        });
                        continue;
                    }

                    const exactHits = byExact.get(String(legacyName).trim().toLowerCase()) || [];
                    const normHits = byNorm.get(normSiteName(legacyName)) || [];
                    // Prefer exact; fall back to normalized; unique by id
                    const hitMap = new Map();
                    for (const h of [...exactHits, ...normHits]) hitMap.set(h.id, h);
                    const hits = [...hitMap.values()];

                    if (hits.length > 1) {
                        results.push({
                            legacySiteId: legacy.id,
                            legacyName,
                            action: 'ambiguous',
                            reason: `Multiple live matches: ${hits.map((h) => h.name).join(', ')}`,
                            candidates: hits.map((h) => ({ id: h.id, name: h.name })),
                        });
                        continue;
                    }

                    if (hits.length === 1) {
                        const live = hits[0];
                        if (!dryRun) {
                            await legacyC.items.upsert({
                                ...legacy,
                                linkedArtemisSiteId: live.id,
                                promotedAt: now,
                                promoteStatus: 'linked',
                                promotedBy: operator,
                                updatedAt: now,
                            });
                            // Soft reverse pointer only — never clobber Chaos fields
                            try {
                                const fullRead = await liveC.item(live.id, live.id).read();
                                const full = fullRead.resource;
                                if (full) {
                                    const ids = Array.isArray(full.legacySiteIds)
                                        ? full.legacySiteIds.slice()
                                        : [];
                                    if (!ids.includes(legacy.id)) ids.push(legacy.id);
                                    await liveC.items.upsert({
                                        ...full,
                                        legacySiteIds: ids,
                                        updatedAt: now,
                                    });
                                }
                            } catch (_) {
                                /* non-fatal */
                            }
                        }
                        results.push({
                            legacySiteId: legacy.id,
                            legacyName,
                            action: 'linked',
                            liveSiteId: live.id,
                            liveSiteName: live.name,
                            reason: dryRun ? 'Would link to existing live site' : 'Linked to existing live site',
                        });
                        continue;
                    }

                    // No match → create minimal live site
                    if (dryRun) {
                        results.push({
                            legacySiteId: legacy.id,
                            legacyName,
                            action: 'created',
                            liveSiteId: null,
                            liveSiteName: legacyName,
                            reason: 'Would create new live site',
                        });
                        continue;
                    }

                    const created = buildLiveSiteFromLegacy(legacy, generateId);
                    // Avoid id collision (extremely unlikely with generateId)
                    if (!created.id) created.id = `site-${slugify(legacyName)}-${Date.now().toString(36)}`;
                    const { resource: newLive } = await liveC.items.create(created);
                    await legacyC.items.upsert({
                        ...legacy,
                        linkedArtemisSiteId: newLive.id,
                        promotedAt: now,
                        promoteStatus: 'created',
                        promotedBy: operator,
                        updatedAt: now,
                    });
                    // Keep match maps updated for subsequent rows in same batch
                    const exact = String(newLive.name).trim().toLowerCase();
                    const norm = normSiteName(newLive.name);
                    if (exact) {
                        if (!byExact.has(exact)) byExact.set(exact, []);
                        byExact.get(exact).push(newLive);
                    }
                    if (norm) {
                        if (!byNorm.has(norm)) byNorm.set(norm, []);
                        byNorm.get(norm).push(newLive);
                    }

                    results.push({
                        legacySiteId: legacy.id,
                        legacyName,
                        action: 'created',
                        liveSiteId: newLive.id,
                        liveSiteName: newLive.name,
                        reason: 'Created new live site (no scheduling/study membership)',
                    });
                }

                const summary = {
                    linked: results.filter((r) => r.action === 'linked').length,
                    created: results.filter((r) => r.action === 'created').length,
                    skipped: results.filter((r) => r.action === 'skipped').length,
                    ambiguous: results.filter((r) => r.action === 'ambiguous').length,
                    error: results.filter((r) => r.action === 'error').length,
                };

                return {
                    status: 200,
                    jsonBody: {
                        ok: true,
                        dryRun,
                        operator,
                        summary,
                        results,
                        safety:
                            'Chaos/NASA untouched: no schedule/patient/study membership writes; matched sites link-only; new sites are inert stubs.',
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'legacy-sites/promote');
            }
        },
    });
}

module.exports = { registerPromoteLegacyRoutes, normSiteName };
