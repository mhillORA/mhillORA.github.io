/**
 * Site merge + graduate remaining master-list (legacy-only) rows → live `sites`.
 *
 * CHAOS / NASA SAFETY:
 * - Never touch schedules, patients, events, crcs.
 * - studies.siteIds: only rewrite absorb→primary membership (no schedule fields).
 * - Never hard-delete sites or legacy docs.
 */
const { normalizeSiteFields, mapToLiveSiteFields, normalizePhone } = require('./lib/site-field-map');

const LIVE_SITES = 'sites';
const LEGACY_SITES = 'legacy-sites';
const ASSIGNMENTS = 'site-survey-assignments';
const RESPONSES = 'site-survey-responses';
const STUDIES = 'studies';

const MERGE_FIELDS = [
    'name',
    'siteCode',
    'siteNameAbbreviation',
    'status',
    'address1',
    'address2',
    'city',
    'state',
    'zip',
    'zipCode',
    'country',
    'phone',
    'sitePhone',
    'pi',
    'piFirstName',
    'piLastName',
    'piEmail',
    'piPhone',
    'pi2Name',
    'pi2Email',
    'pi3Name',
    'pi3Email',
    'siteCoordinator',
    'siteCoordinatorEmail',
    'siteCoordinatorPhone',
    'siteCoordinator2Name',
    'siteCoordinator2Email',
    'siteCoordinator3Name',
    'siteCoordinator3Email',
    'notes',
    'mailingAddress1',
    'mailingAddress2',
    'mailingCity',
    'mailingState',
    'mailingZipCode',
    'mailingCountry',
];

function corsHeaders() {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Artemis-Operator',
    };
}

function readHeader(request, name) {
    try {
        if (request.headers && typeof request.headers.get === 'function') {
            return request.headers.get(name) || request.headers.get(name.toLowerCase());
        }
    } catch (_) {}
    if (request.headers) return request.headers[name] || request.headers[name.toLowerCase()];
    return undefined;
}

function trimStr(v) {
    return String(v == null ? '' : v).trim();
}

function normSiteName(s) {
    return String(s ?? '')
        .toLowerCase()
        .replace(/\b(inc\.?|llc|corp\.?|ltd\.?|pllc|pc|md|dr\.?|sc)\b/gi, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function isLegacyId(id) {
    const s = String(id || '');
    return s.startsWith('legacy-') || s.includes('feas-');
}

function pickValue(primary, absorb, field, choice) {
    const p = primary?.[field];
    const a = absorb?.[field];
    const pEmpty = p == null || String(p).trim() === '';
    const aEmpty = a == null || String(a).trim() === '';
    if (choice === 'absorb') return aEmpty ? p : a;
    if (choice === 'primary') return pEmpty ? a : p;
    // default: keep primary when set, else take absorb
    return pEmpty ? a : p;
}

function legacyAsSiteShape(leg) {
    if (!leg) return {};
    const mapped = mapToLiveSiteFields(leg) || {};
    return normalizeSiteFields({
        ...mapped,
        id: leg.id,
        name: mapped.name || leg.name || leg.institution_name || leg.id,
        siteCode: leg.siteCode || leg.siteNameAbbreviation || '',
        siteNameAbbreviation: leg.siteNameAbbreviation || leg.siteCode || '',
        notes: leg.notes || '',
        status: 'Active',
        _source: 'legacy',
    });
}

async function loadLive(getContainer, id) {
    try {
        const { resource } = await getContainer(LIVE_SITES).item(id, id).read();
        return resource || null;
    } catch (_) {
        return null;
    }
}

async function loadLegacy(getContainer, id) {
    try {
        const { resource } = await getContainer(LEGACY_SITES).item(id, id).read();
        return resource || null;
    } catch (_) {
        return null;
    }
}

async function countBySiteId(getContainer, containerId, siteId) {
    try {
        const { resources } = await getContainer(containerId)
            .items.query(
                {
                    query: 'SELECT VALUE COUNT(1) FROM c WHERE c.siteId = @sid',
                    parameters: [{ name: '@sid', value: String(siteId) }],
                },
                { enableCrossPartitionQuery: true }
            )
            .fetchAll();
        return Number(resources?.[0] || 0);
    } catch (_) {
        return 0;
    }
}

async function rebindSiteId(getContainer, containerId, fromId, toId) {
    const moved = [];
    const { resources } = await getContainer(containerId)
        .items.query(
            {
                query: 'SELECT * FROM c WHERE c.siteId = @sid',
                parameters: [{ name: '@sid', value: String(fromId) }],
            },
            { enableCrossPartitionQuery: true }
        )
        .fetchAll();
    for (const doc of resources || []) {
        const prior = Array.isArray(doc.priorSiteIds) ? doc.priorSiteIds.slice() : [];
        if (!prior.includes(fromId)) prior.push(String(fromId));
        doc.siteId = String(toId);
        doc.priorSiteIds = prior;
        doc.updatedAt = new Date().toISOString();
        doc._mergedFromSiteId = String(fromId);
        await getContainer(containerId).items.upsert(doc);
        moved.push(doc.id);
    }
    return moved;
}

async function rewriteStudySiteIds(getContainer, fromId, toId) {
    const touched = [];
    const { resources } = await getContainer(STUDIES)
        .items.query(
            {
                query: 'SELECT c.id, c.siteIds FROM c WHERE ARRAY_CONTAINS(c.siteIds, @sid)',
                parameters: [{ name: '@sid', value: String(fromId) }],
            },
            { enableCrossPartitionQuery: true }
        )
        .fetchAll();
    for (const row of resources || []) {
        try {
            const { resource: study } = await getContainer(STUDIES).item(row.id, row.id).read();
            if (!study) continue;
            const ids = Array.isArray(study.siteIds) ? study.siteIds.map(String) : [];
            if (!ids.includes(String(fromId))) continue;
            const next = [];
            const seen = new Set();
            for (const id of ids) {
                const v = id === String(fromId) ? String(toId) : id;
                if (seen.has(v)) continue;
                seen.add(v);
                next.push(v);
            }
            study.siteIds = next;
            study.updatedAt = new Date().toISOString();
            await getContainer(STUDIES).items.upsert(study);
            touched.push(study.id);
        } catch (_) {}
    }
    return touched;
}

function buildMergedPrimary(primary, absorbShape, fieldChoices = {}) {
    const out = { ...primary };
    for (const field of MERGE_FIELDS) {
        const choice = fieldChoices[field] === 'absorb' ? 'absorb' : 'primary';
        const val = pickValue(primary, absorbShape, field, choice);
        if (val != null && String(val).trim() !== '') out[field] = val;
    }
    if (out.phone) out.phone = normalizePhone(out.phone) || out.phone;
    if (out.sitePhone) out.sitePhone = normalizePhone(out.sitePhone) || out.sitePhone;
    if (out.piPhone) out.piPhone = normalizePhone(out.piPhone) || out.piPhone;
    if (out.zip && !out.zipCode) out.zipCode = out.zip;
    if (out.zipCode && !out.zip) out.zip = out.zipCode;
    if (out.siteCode && !out.siteNameAbbreviation) out.siteNameAbbreviation = out.siteCode;
    if (out.siteNameAbbreviation && !out.siteCode) out.siteCode = out.siteNameAbbreviation;
    return normalizeSiteFields(out);
}

function fieldDiff(primary, absorbShape) {
    const rows = [];
    for (const field of MERGE_FIELDS) {
        const p = trimStr(primary?.[field]);
        const a = trimStr(absorbShape?.[field]);
        if (!p && !a) continue;
        if (p === a) continue;
        rows.push({
            field,
            primary: p || null,
            absorb: a || null,
            defaultChoice: p ? 'primary' : 'absorb',
        });
    }
    return rows;
}

function registerSiteMergeRoutes(app, deps) {
    const { getContainer, handleError, generateId } = deps;

    app.http('sitesMerge', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'sites/merge',
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
                const primarySiteId = String(body?.primarySiteId || '').trim();
                const absorbSiteId = String(body?.absorbSiteId || '').trim();
                let absorbSource = String(body?.absorbSource || '').trim().toLowerCase();
                const fieldChoices = body?.fieldChoices && typeof body.fieldChoices === 'object'
                    ? body.fieldChoices
                    : {};

                if (!primarySiteId || !absorbSiteId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'primarySiteId and absorbSiteId are required' },
                        headers: corsHeaders(),
                    };
                }
                if (primarySiteId === absorbSiteId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Primary and absorb must be different sites' },
                        headers: corsHeaders(),
                    };
                }

                const primary = await loadLive(getContainer, primarySiteId);
                if (!primary) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Primary must be a live site in the sites container' },
                        headers: corsHeaders(),
                    };
                }
                if (String(primary.status || '').toLowerCase() === 'merged') {
                    return {
                        status: 400,
                        jsonBody: { error: 'Primary site is already merged into another site' },
                        headers: corsHeaders(),
                    };
                }

                if (!absorbSource) {
                    absorbSource = (await loadLive(getContainer, absorbSiteId))
                        ? 'live'
                        : 'legacy';
                }

                let absorbLive = null;
                let absorbLegacy = null;
                let absorbShape = {};
                if (absorbSource === 'live') {
                    absorbLive = await loadLive(getContainer, absorbSiteId);
                    if (!absorbLive) {
                        return {
                            status: 404,
                            jsonBody: { error: 'Absorb live site not found' },
                            headers: corsHeaders(),
                        };
                    }
                    absorbShape = normalizeSiteFields(absorbLive);
                } else {
                    absorbLegacy = await loadLegacy(getContainer, absorbSiteId);
                    if (!absorbLegacy) {
                        return {
                            status: 404,
                            jsonBody: { error: 'Absorb legacy/master-list site not found' },
                            headers: corsHeaders(),
                        };
                    }
                    absorbShape = legacyAsSiteShape(absorbLegacy);
                }

                const asgCount = await countBySiteId(getContainer, ASSIGNMENTS, absorbSiteId);
                const rspCount = await countBySiteId(getContainer, RESPONSES, absorbSiteId);
                const diff = fieldDiff(primary, absorbShape);
                const mergedPreview = buildMergedPrimary(primary, absorbShape, fieldChoices);
                const now = new Date().toISOString();

                const summary = {
                    dryRun,
                    primarySiteId,
                    primaryName: primary.name,
                    absorbSiteId,
                    absorbSource,
                    absorbName: absorbShape.name || absorbSiteId,
                    conflictingFields: diff.length,
                    fieldDiff: diff,
                    surveyAssignmentsToMove: asgCount,
                    surveyResponsesToMove: rspCount,
                    mergedPreview: {
                        name: mergedPreview.name,
                        siteCode: mergedPreview.siteCode || mergedPreview.siteNameAbbreviation,
                        address1: mergedPreview.address1,
                        city: mergedPreview.city,
                        state: mergedPreview.state,
                        zip: mergedPreview.zip || mergedPreview.zipCode,
                        piEmail: mergedPreview.piEmail,
                        siteCoordinatorEmail: mergedPreview.siteCoordinatorEmail,
                    },
                };

                if (dryRun) {
                    return {
                        status: 200,
                        jsonBody: { ok: true, ...summary },
                        headers: corsHeaders(),
                    };
                }

                // --- apply ---
                const nextPrimary = buildMergedPrimary(primary, absorbShape, fieldChoices);
                nextPrimary.id = primary.id;
                nextPrimary.updatedAt = now;
                nextPrimary.mergedAt = now;
                nextPrimary.mergedBy = operator;

                const legacyIds = new Set(
                    [...(Array.isArray(primary.legacySiteIds) ? primary.legacySiteIds : [])].map(String)
                );
                if (absorbSource === 'legacy') {
                    legacyIds.add(String(absorbSiteId));
                } else if (absorbLive) {
                    if (absorbLive.promotedFromLegacySiteId) {
                        legacyIds.add(String(absorbLive.promotedFromLegacySiteId));
                    }
                    (absorbLive.legacySiteIds || []).forEach((id) => legacyIds.add(String(id)));
                }
                legacyIds.add(String(absorbSiteId));
                nextPrimary.legacySiteIds = [...legacyIds];
                if (!nextPrimary.promotedFromLegacySiteId && absorbLive?.promotedFromLegacySiteId) {
                    nextPrimary.promotedFromLegacySiteId = absorbLive.promotedFromLegacySiteId;
                }

                await getContainer(LIVE_SITES).items.upsert(nextPrimary);

                const movedAssignments = await rebindSiteId(
                    getContainer,
                    ASSIGNMENTS,
                    absorbSiteId,
                    primarySiteId
                );
                const movedResponses = await rebindSiteId(
                    getContainer,
                    RESPONSES,
                    absorbSiteId,
                    primarySiteId
                );
                const studiesTouched = await rewriteStudySiteIds(
                    getContainer,
                    absorbSiteId,
                    primarySiteId
                );

                if (absorbSource === 'live' && absorbLive) {
                    absorbLive.status = 'Merged';
                    absorbLive.mergedIntoSiteId = primarySiteId;
                    absorbLive.mergedAt = now;
                    absorbLive.mergedBy = operator;
                    absorbLive.updatedAt = now;
                    await getContainer(LIVE_SITES).items.upsert(absorbLive);
                }

                if (absorbSource === 'legacy' && absorbLegacy) {
                    absorbLegacy.linkedArtemisSiteId = primarySiteId;
                    absorbLegacy.promoteStatus = 'merged';
                    absorbLegacy.mergedIntoSiteId = primarySiteId;
                    absorbLegacy.mergedAt = now;
                    absorbLegacy.mergedBy = operator;
                    absorbLegacy.updatedAt = now;
                    await getContainer(LEGACY_SITES).items.upsert(absorbLegacy);
                } else if (absorbSource === 'live' && absorbLive) {
                    // Also mark any legacy rows pointed at the absorbed live id
                    try {
                        const { resources: legs } = await getContainer(LEGACY_SITES)
                            .items.query(
                                {
                                    query: 'SELECT * FROM c WHERE c.linkedArtemisSiteId = @lid',
                                    parameters: [{ name: '@lid', value: String(absorbSiteId) }],
                                },
                                { enableCrossPartitionQuery: true }
                            )
                            .fetchAll();
                        for (const leg of legs || []) {
                            leg.linkedArtemisSiteId = primarySiteId;
                            leg.promoteStatus = 'merged';
                            leg.mergedIntoSiteId = primarySiteId;
                            leg.mergedAt = now;
                            leg.updatedAt = now;
                            await getContainer(LEGACY_SITES).items.upsert(leg);
                        }
                    } catch (_) {}
                }

                return {
                    status: 200,
                    jsonBody: {
                        ok: true,
                        ...summary,
                        applied: true,
                        movedAssignmentIds: movedAssignments,
                        movedResponseIds: movedResponses,
                        studiesUpdated: studiesTouched,
                        primary: {
                            id: nextPrimary.id,
                            name: nextPrimary.name,
                            legacySiteIds: nextPrimary.legacySiteIds,
                        },
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'sites/merge');
            }
        },
    });

    /**
     * Graduate all (or listed) unlinked legacy-sites into live sites.
     * Name-match → link; else create live stub + link. Removes master-only catalog rows.
     */
    app.http('sitesGraduateLegacy', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'sites/graduate-legacy',
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
                const onlyIds = Array.isArray(body?.legacySiteIds)
                    ? body.legacySiteIds.map(String).filter(Boolean)
                    : null;

                const legacyC = getContainer(LEGACY_SITES);
                const liveC = getContainer(LIVE_SITES);

                let legacyRows = [];
                if (onlyIds?.length) {
                    for (const id of onlyIds) {
                        const leg = await loadLegacy(getContainer, id);
                        if (leg) legacyRows.push(leg);
                    }
                } else {
                    const { resources } = await legacyC.items
                        .query(
                            {
                                query:
                                    'SELECT * FROM c WHERE NOT IS_DEFINED(c.linkedArtemisSiteId) OR c.linkedArtemisSiteId = null OR c.linkedArtemisSiteId = ""',
                            },
                            { enableCrossPartitionQuery: true }
                        )
                        .fetchAll();
                    legacyRows = resources || [];
                }

                const { resources: liveRows } = await liveC.items
                    .query(
                        {
                            query:
                                'SELECT c.id, c.name, c.status, c.legacySiteIds, c.promotedFromLegacySiteId FROM c',
                        },
                        { enableCrossPartitionQuery: true }
                    )
                    .fetchAll();
                const liveSites = (liveRows || []).filter(
                    (s) => String(s.status || '').toLowerCase() !== 'merged'
                );
                const byName = new Map();
                for (const s of liveSites) {
                    const k = normSiteName(s.name);
                    if (!k) continue;
                    const arr = byName.get(k) || [];
                    arr.push(s);
                    byName.set(k, arr);
                }

                const now = new Date().toISOString();
                const results = [];
                let linked = 0;
                let created = 0;
                let skipped = 0;

                for (const leg of legacyRows) {
                    if (leg.linkedArtemisSiteId) {
                        skipped += 1;
                        results.push({
                            legacySiteId: leg.id,
                            action: 'already_linked',
                            liveSiteId: leg.linkedArtemisSiteId,
                        });
                        continue;
                    }
                    const key = normSiteName(leg.name || leg.institution_name);
                    const hits = key ? byName.get(key) || [] : [];
                    if (hits.length === 1) {
                        const live = hits[0];
                        if (!dryRun) {
                            const full = await loadLive(getContainer, live.id);
                            if (full) {
                                const ids = new Set(
                                    [...(full.legacySiteIds || [])].map(String)
                                );
                                ids.add(String(leg.id));
                                full.legacySiteIds = [...ids];
                                full.updatedAt = now;
                                await liveC.items.upsert(full);
                            }
                            leg.linkedArtemisSiteId = live.id;
                            leg.promoteStatus = 'linked';
                            leg.graduatedAt = now;
                            leg.graduatedBy = operator;
                            leg.updatedAt = now;
                            await legacyC.items.upsert(leg);
                        }
                        linked += 1;
                        results.push({
                            legacySiteId: leg.id,
                            name: leg.name,
                            action: 'linked',
                            liveSiteId: live.id,
                        });
                        continue;
                    }
                    if (hits.length > 1) {
                        skipped += 1;
                        results.push({
                            legacySiteId: leg.id,
                            name: leg.name,
                            action: 'ambiguous',
                            liveCandidates: hits.map((h) => h.id),
                        });
                        continue;
                    }

                    // create live stub
                    const mapped = mapToLiveSiteFields(leg) || {};
                    const newLive = {
                        id: generateId(),
                        ...normalizeSiteFields({
                            ...mapped,
                            name: mapped.name || leg.name || leg.institution_name || 'Graduated site',
                            status: 'Active',
                        }),
                        source: 'promoted-from-legacy',
                        promotedFromLegacySiteId: leg.id,
                        legacySiteIds: [leg.id],
                        createdAt: now,
                        updatedAt: now,
                        graduatedAt: now,
                        graduatedBy: operator,
                    };
                    if (!dryRun) {
                        await liveC.items.create(newLive);
                        leg.linkedArtemisSiteId = newLive.id;
                        leg.promoteStatus = 'created';
                        leg.graduatedAt = now;
                        leg.graduatedBy = operator;
                        leg.updatedAt = now;
                        await legacyC.items.upsert(leg);
                        const k2 = normSiteName(newLive.name);
                        if (k2) {
                            const arr = byName.get(k2) || [];
                            arr.push({ id: newLive.id, name: newLive.name });
                            byName.set(k2, arr);
                        }
                    }
                    created += 1;
                    results.push({
                        legacySiteId: leg.id,
                        name: leg.name,
                        action: 'created',
                        liveSiteId: dryRun ? '(pending)' : newLive.id,
                    });
                }

                return {
                    status: 200,
                    jsonBody: {
                        ok: true,
                        dryRun,
                        scanned: legacyRows.length,
                        linked,
                        created,
                        skipped,
                        results,
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'sites/graduate-legacy');
            }
        },
    });
}

module.exports = { registerSiteMergeRoutes, MERGE_FIELDS };
