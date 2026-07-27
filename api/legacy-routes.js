/**
 * Legacy Studies API — ARTEMIS only.
 * Uses NEW Cosmos containers only. Never reads/writes studies|sites|patients|crcs|events.
 * Containers: legacy-studies (/id), legacy-study-site-outcomes (/studyId)
 */
const LEGACY_STUDIES = 'legacy-studies';
const LEGACY_SITES = 'legacy-sites';
const LEGACY_OUTCOMES = 'legacy-study-site-outcomes';

function corsHeaders() {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    };
}

function slugify(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'unknown';
}

async function ensureLegacyContainers(getCosmosClient, context) {
    const { database } = getCosmosClient();
    await database.containers.createIfNotExists({
        id: LEGACY_STUDIES,
        partitionKey: { paths: ['/id'] },
    });
    await database.containers.createIfNotExists({
        id: LEGACY_SITES,
        partitionKey: { paths: ['/id'] },
    });
    await database.containers.createIfNotExists({
        id: LEGACY_OUTCOMES,
        partitionKey: { paths: ['/studyId'] },
    });
    if (context?.log) context.log(`Ensured containers ${LEGACY_STUDIES}, ${LEGACY_SITES}, ${LEGACY_OUTCOMES}`);
}

function registerLegacyRoutes(app, deps) {
    const { getContainer, getCosmosClient, handleError, generateId } = deps;

    const getBody = async (request) => {
        try {
            return await request.json();
        } catch {
            return {};
        }
    };

    const getId = (request) => {
        try {
            if (request.params?.id) return request.params.id;
        } catch (_) { /* ignore */ }
        const m = String(request.url || '').match(/\/([^\/\?]+)(?:\?|$)/);
        // last path segment after route base is unreliable; prefer params
        return request.params?.id || null;
    };

    // ---------- legacy-studies ----------
    app.http('legacyStudies', {
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'legacy-studies/{id?}',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                await ensureLegacyContainers(getCosmosClient, context);
                const container = getContainer(LEGACY_STUDIES);
                const id = request.params?.id || null;
                const method = request.method;

                if (method === 'GET') {
                    if (id) {
                        const { resource } = await container.item(id, id).read();
                        if (!resource) {
                            return { status: 404, jsonBody: { error: 'Legacy study not found' }, headers: corsHeaders() };
                        }
                        return { jsonBody: resource, headers: corsHeaders() };
                    }
                    const { resources } = await container.items
                        .query({ query: 'SELECT * FROM c ORDER BY c.name ASC' }, { enableCrossPartitionQuery: true })
                        .fetchAll();
                    return { jsonBody: resources || [], headers: corsHeaders() };
                }

                if (method === 'POST') {
                    const body = await getBody(request);
                    const name = (body.name || body.title || '').trim();
                    if (!name) {
                        return { status: 400, jsonBody: { error: 'name is required' }, headers: corsHeaders() };
                    }
                    const now = new Date().toISOString();
                    const newId = body.id || `legacy-study-${slugify(name)}`;
                    const item = {
                        id: newId,
                        type: 'legacyStudy',
                        name,
                        title: body.title || name,
                        therapeuticArea: body.therapeuticArea ?? null,
                        indication: body.indication ?? null,
                        sponsor: body.sponsor ?? null,
                        phase: body.phase ?? null,
                        status: body.status || 'Completed',
                        notes: body.notes ?? null,
                        source: body.source || 'manual',
                        metrics: body.metrics || {},
                        editableFields: true,
                        createdAt: now,
                        updatedAt: now,
                    };
                    const { resource } = await container.items.upsert(item);
                    return { status: 201, jsonBody: resource, headers: corsHeaders() };
                }

                if (method === 'PUT' || method === 'PATCH') {
                    if (!id) {
                        return { status: 400, jsonBody: { error: 'id required' }, headers: corsHeaders() };
                    }
                    const body = await getBody(request);
                    let existing = null;
                    try {
                        const read = await container.item(id, id).read();
                        existing = read.resource;
                    } catch (_) {
                        existing = null;
                    }
                    if (!existing) {
                        return { status: 404, jsonBody: { error: 'Legacy study not found' }, headers: corsHeaders() };
                    }
                    // Allow editing metadata without clobbering metrics unless provided
                    const editable = [
                        'name', 'title', 'therapeuticArea', 'indication', 'sponsor',
                        'phase', 'status', 'notes',
                    ];
                    const updated = { ...existing };
                    for (const k of editable) {
                        if (body[k] !== undefined) updated[k] = body[k];
                    }
                    if (body.metrics && typeof body.metrics === 'object') {
                        updated.metrics = { ...(existing.metrics || {}), ...body.metrics };
                    }
                    updated.updatedAt = new Date().toISOString();
                    const { resource } = await container.items.upsert(updated);
                    return { jsonBody: resource, headers: corsHeaders() };
                }

                if (method === 'DELETE') {
                    if (!id) {
                        return { status: 400, jsonBody: { error: 'id required' }, headers: corsHeaders() };
                    }
                    await container.item(id, id).delete();
                    return { status: 204, headers: corsHeaders() };
                }

                return { status: 405, jsonBody: { error: 'Method not allowed' }, headers: corsHeaders() };
            } catch (error) {
                return handleError(context, error, 'legacy-studies');
            }
        },
    });

    // ---------- legacy-sites (one doc per unique dropdown site) ----------
    app.http('legacySites', {
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'legacy-sites/{id?}',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                await ensureLegacyContainers(getCosmosClient, context);
                const container = getContainer(LEGACY_SITES);
                const id = request.params?.id || null;
                const method = request.method;

                if (method === 'GET') {
                    if (id) {
                        const { resource } = await container.item(id, id).read();
                        if (!resource) {
                            return { status: 404, jsonBody: { error: 'Legacy site not found' }, headers: corsHeaders() };
                        }
                        return { jsonBody: resource, headers: corsHeaders() };
                    }
                    const { resources } = await container.items
                        .query({ query: 'SELECT * FROM c' }, { enableCrossPartitionQuery: true })
                        .fetchAll();
                    const rows = (resources || []).slice().sort((a, b) =>
                        String(a.name || '').localeCompare(String(b.name || ''))
                    );
                    return { jsonBody: rows, headers: corsHeaders() };
                }

                if (method === 'POST') {
                    const body = await getBody(request);
                    const name = (body.name || '').trim();
                    if (!name) {
                        return { status: 400, jsonBody: { error: 'name is required' }, headers: corsHeaders() };
                    }
                    const now = new Date().toISOString();
                    const newId = body.id || `legacy-site-${slugify(name)}`;
                    const item = {
                        id: newId,
                        type: 'legacySite',
                        name,
                        siteCode: body.siteCode || slugify(name).toUpperCase().replace(/-/g, '_').slice(0, 32),
                        status: body.status || 'Active',
                        notes: body.notes ?? null,
                        relationshipPreference: body.relationshipPreference ?? null,
                        advantages: body.advantages ?? null,
                        disadvantages: body.disadvantages ?? null,
                        relationshipNotes: body.relationshipNotes ?? null,
                        linkedArtemisSiteId: body.linkedArtemisSiteId ?? null,
                        source: body.source || 'manual',
                        metrics: body.metrics || {},
                        editableFields: true,
                        createdAt: now,
                        updatedAt: now,
                    };
                    const { resource } = await container.items.upsert(item);
                    return { status: 201, jsonBody: resource, headers: corsHeaders() };
                }

                if (method === 'PUT' || method === 'PATCH') {
                    if (!id) {
                        return { status: 400, jsonBody: { error: 'id required' }, headers: corsHeaders() };
                    }
                    const body = await getBody(request);
                    let existing = null;
                    try {
                        const read = await container.item(id, id).read();
                        existing = read.resource;
                    } catch (_) {
                        existing = null;
                    }
                    if (!existing) {
                        return { status: 404, jsonBody: { error: 'Legacy site not found' }, headers: corsHeaders() };
                    }
                    const editable = [
                        'name',
                        'siteCode',
                        'status',
                        'notes',
                        'linkedArtemisSiteId',
                        'relationshipPreference',
                        'advantages',
                        'disadvantages',
                        'relationshipNotes',
                    ];
                    const updated = { ...existing };
                    for (const k of editable) {
                        if (body[k] !== undefined) updated[k] = body[k];
                    }
                    if (body.relationshipPreference !== undefined) {
                        const allowed = new Set(['prefer', 'neutral', 'cautious', 'avoid', null, '']);
                        if (!allowed.has(body.relationshipPreference)) {
                            return {
                                status: 400,
                                jsonBody: {
                                    error: 'relationshipPreference must be prefer|neutral|cautious|avoid (or empty)',
                                },
                                headers: corsHeaders(),
                            };
                        }
                        updated.relationshipPreference = body.relationshipPreference || null;
                    }
                    if (body.metrics && typeof body.metrics === 'object') {
                        updated.metrics = { ...(existing.metrics || {}), ...body.metrics };
                    }
                    updated.updatedAt = new Date().toISOString();
                    const { resource } = await container.items.upsert(updated);
                    return { jsonBody: resource, headers: corsHeaders() };
                }

                if (method === 'DELETE') {
                    if (!id) {
                        return { status: 400, jsonBody: { error: 'id required' }, headers: corsHeaders() };
                    }
                    await container.item(id, id).delete();
                    return { status: 204, headers: corsHeaders() };
                }

                return { status: 405, jsonBody: { error: 'Method not allowed' }, headers: corsHeaders() };
            } catch (error) {
                return handleError(context, error, 'legacy-sites');
            }
        },
    });

    // ---------- legacy-study-site-outcomes ----------
    app.http('legacyStudySiteOutcomes', {
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'legacy-study-site-outcomes/{id?}',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                await ensureLegacyContainers(getCosmosClient, context);
                const container = getContainer(LEGACY_OUTCOMES);
                const id = request.params?.id || null;
                const method = request.method;

                const readQuery = (name) => {
                    try {
                        if (request.query && typeof request.query.get === 'function') {
                            return request.query.get(name);
                        }
                        if (request.query && request.query[name] != null) return request.query[name];
                    } catch (_) { /* ignore */ }
                    try {
                        const raw = String(request.url || '');
                        const qIdx = raw.indexOf('?');
                        if (qIdx >= 0) {
                            const sp = new URLSearchParams(raw.slice(qIdx + 1));
                            return sp.get(name);
                        }
                    } catch (_) { /* ignore */ }
                    return null;
                };
                const studyId = readQuery('studyId');
                const siteName = readQuery('siteName');

                if (method === 'GET') {
                    if (id && studyId) {
                        const { resource } = await container.item(id, studyId).read();
                        if (!resource) {
                            return { status: 404, jsonBody: { error: 'Outcome not found' }, headers: corsHeaders() };
                        }
                        return { jsonBody: resource, headers: corsHeaders() };
                    }
                    // Prefer partition-scoped read when studyId is present (faster + reliable)
                    const where = [];
                    const parameters = [];
                    if (studyId) {
                        where.push('c.studyId = @studyId');
                        parameters.push({ name: '@studyId', value: String(studyId) });
                    }
                    if (siteName) {
                        where.push('c.siteName = @siteName');
                        parameters.push({ name: '@siteName', value: String(siteName) });
                    }
                    // Avoid ORDER BY on cross-partition (can fail / be slow). Sort in app.
                    // Do not SELECT c.group — "group" is a reserved Cosmos SQL keyword; SELECT * is fine.
                    const query = {
                        query: `SELECT * FROM c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
                            .replace(/\s+/g, ' ')
                            .trim(),
                        parameters,
                    };
                    const queryOpts = { enableCrossPartitionQuery: true };
                    if (studyId) {
                        // Partition key is /studyId — scope the query when filtering by study
                        queryOpts.partitionKey = String(studyId);
                    }
                    const { resources } = await container.items.query(query, queryOpts).fetchAll();
                    const rows = (resources || []).slice().sort((a, b) => {
                        const sn = String(a.studyName || '').localeCompare(String(b.studyName || ''));
                        if (sn !== 0) return sn;
                        return String(a.siteName || '').localeCompare(String(b.siteName || ''));
                    });
                    return { jsonBody: rows, headers: corsHeaders() };
                }

                if (method === 'POST') {
                    const body = await getBody(request);
                    if (!body.studyId || !body.studyName || !body.siteName) {
                        return {
                            status: 400,
                            jsonBody: { error: 'studyId, studyName, and siteName are required' },
                            headers: corsHeaders(),
                        };
                    }
                    const now = new Date().toISOString();
                    const item = {
                        id: body.id || `legacy-outcome-${generateId()}`,
                        type: 'legacyStudySiteOutcome',
                        studyId: body.studyId,
                        studyName: body.studyName,
                        siteName: body.siteName,
                        group: body.group ?? null,
                        pi: body.pi ?? null,
                        visit1Start: body.visit1Start ?? null,
                        lplv: body.lplv ?? null,
                        targetScheduled: body.targetScheduled ?? null,
                        scheduled: body.scheduled ?? null,
                        screened: body.screened ?? body.screen ?? null,
                        enrolled: body.enrolled ?? null,
                        uniqueId: body.uniqueId ?? null,
                        source: body.source || 'anterior-segment-overview',
                        ingestedAt: body.ingestedAt || now,
                        createdAt: now,
                        updatedAt: now,
                    };
                    const { resource } = await container.items.upsert(item);
                    return { status: 201, jsonBody: resource, headers: corsHeaders() };
                }

                if (method === 'PUT') {
                    const body = await getBody(request);
                    const pk = body.studyId || studyId;
                    if (!id || !pk) {
                        return { status: 400, jsonBody: { error: 'id and studyId required' }, headers: corsHeaders() };
                    }
                    let existing = null;
                    try {
                        const read = await container.item(id, pk).read();
                        existing = read.resource;
                    } catch (_) {
                        existing = null;
                    }
                    if (!existing) {
                        return { status: 404, jsonBody: { error: 'Outcome not found' }, headers: corsHeaders() };
                    }
                    const updated = {
                        ...existing,
                        ...body,
                        id: existing.id,
                        studyId: existing.studyId,
                        type: 'legacyStudySiteOutcome',
                        updatedAt: new Date().toISOString(),
                    };
                    const { resource } = await container.items.upsert(updated);
                    return { jsonBody: resource, headers: corsHeaders() };
                }

                if (method === 'DELETE') {
                    const pk = studyId;
                    if (!id || !pk) {
                        return { status: 400, jsonBody: { error: 'id and studyId query param required' }, headers: corsHeaders() };
                    }
                    await container.item(id, pk).delete();
                    return { status: 204, headers: corsHeaders() };
                }

                return { status: 405, jsonBody: { error: 'Method not allowed' }, headers: corsHeaders() };
            } catch (error) {
                return handleError(context, error, 'legacy-study-site-outcomes');
            }
        },
    });

    // Aggregate report endpoint (read-only)
    app.http('legacyReportingSummary', {
        methods: ['GET', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'legacy-reporting/summary',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                await ensureLegacyContainers(getCosmosClient, context);
                const studiesC = getContainer(LEGACY_STUDIES);
                const sitesC = getContainer(LEGACY_SITES);
                const outcomesC = getContainer(LEGACY_OUTCOMES);
                const [{ resources: studies }, { resources: sites }, { resources: outcomes }] = await Promise.all([
                    studiesC.items.query({ query: 'SELECT * FROM c' }, { enableCrossPartitionQuery: true }).fetchAll(),
                    sitesC.items.query({ query: 'SELECT * FROM c' }, { enableCrossPartitionQuery: true }).fetchAll(),
                    outcomesC.items.query({ query: 'SELECT * FROM c' }, { enableCrossPartitionQuery: true }).fetchAll(),
                ]);

                const totals = {
                    studies: (studies || []).length,
                    uniqueSites: (sites || []).length,
                    siteRows: (outcomes || []).length,
                    targetScheduled: 0,
                    scheduled: 0,
                    screened: 0,
                    enrolled: 0,
                };
                for (const o of outcomes || []) {
                    totals.targetScheduled += Number(o.targetScheduled) || 0;
                    totals.scheduled += Number(o.scheduled) || 0;
                    totals.screened += Number(o.screened) || 0;
                    totals.enrolled += Number(o.enrolled) || 0;
                }
                const byTherapeuticArea = {};
                for (const s of studies || []) {
                    const ta = s.therapeuticArea || 'Unspecified';
                    if (!byTherapeuticArea[ta]) {
                        byTherapeuticArea[ta] = { studies: 0, enrolled: 0, screened: 0, enrolled: 0 };
                    }
                    byTherapeuticArea[ta].studies += 1;
                    const m = s.metrics || {};
                    byTherapeuticArea[ta].enrolled += Number(m.enrolled) || 0;
                    byTherapeuticArea[ta].screened += Number(m.screened) || 0;
                    byTherapeuticArea[ta].scheduled += Number(m.scheduled) || 0;
                }

                return {
                    jsonBody: {
                        totals,
                        byTherapeuticArea,
                        studies: studies || [],
                        sites: sites || [],
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'legacy-reporting/summary');
            }
        },
    });
}

module.exports = { registerLegacyRoutes, ensureLegacyContainers, LEGACY_STUDIES, LEGACY_SITES, LEGACY_OUTCOMES };
