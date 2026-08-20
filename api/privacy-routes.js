/**
 * ARTEMIS privacy / GDPR ops — does not touch NASA or CHAOS routes.
 * Containers: privacy-audit-log (/id)
 * Operates on site-survey-* data for subject access & erasure.
 */
const AUDIT_CONTAINER = 'privacy-audit-log';
const RESPONSES = 'site-survey-responses';
const ASSIGNMENTS = 'site-survey-assignments';

function corsHeaders() {
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Artemis-Privacy-Key,X-Artemis-Operator',
    };
}

function readQueryParam(request, name) {
    if (request.query && typeof request.query.get === 'function') return request.query.get(name);
    if (request.query) return request.query[name];
    return null;
}

function readHeader(request, name) {
    try {
        if (request.headers && typeof request.headers.get === 'function') {
            return request.headers.get(name) || request.headers.get(name.toLowerCase());
        }
        if (request.headers) {
            return request.headers[name] || request.headers[name.toLowerCase()];
        }
    } catch (_) {}
    return null;
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function assertPrivacyKey(request) {
    const required = process.env.PRIVACY_OPS_KEY;
    if (!required) return null; // optional until ops sets it
    const got = readHeader(request, 'X-Artemis-Privacy-Key');
    if (!got || got !== required) {
        return {
            status: 401,
            jsonBody: { error: 'Missing or invalid X-Artemis-Privacy-Key' },
            headers: corsHeaders(),
        };
    }
    return null;
}

async function ensurePrivacyContainer(getCosmosClient, context) {
    const { database } = getCosmosClient();
    await database.containers.createIfNotExists({
        id: AUDIT_CONTAINER,
        partitionKey: { paths: ['/id'] },
    });
    if (context?.log) context.log(`Ensured container ${AUDIT_CONTAINER}`);
}

async function writeAudit(getContainer, generateId, entry) {
    const now = new Date().toISOString();
    const doc = {
        id: generateId(),
        type: 'privacyAuditEvent',
        createdAt: now,
        ...entry,
    };
    try {
        const c = getContainer(AUDIT_CONTAINER);
        await c.items.create(doc);
    } catch (e) {
        // non-fatal for caller; still return doc for response
        console.warn('privacy audit write failed', e.message);
    }
    return doc;
}

function registerPrivacyRoutes(app, deps) {
    const { getContainer, getCosmosClient, handleError, generateId } = deps;

    const getBody = async (request) => {
        try {
            return await request.json();
        } catch (_) {
            return {};
        }
    };

    // ---------- Export (subject access) ----------
    app.http('privacyExport', {
        methods: ['GET', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'privacy/export',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            const keyFail = assertPrivacyKey(request);
            if (keyFail) return keyFail;

            try {
                await ensurePrivacyContainer(getCosmosClient, context);
                const email = normalizeEmail(readQueryParam(request, 'email'));
                const siteId = readQueryParam(request, 'siteId');
                const operator = readHeader(request, 'X-Artemis-Operator') || readQueryParam(request, 'operator') || 'unknown';

                if (!email && !siteId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Provide email and/or siteId' },
                        headers: corsHeaders(),
                    };
                }

                const rspC = getContainer(RESPONSES);
                const asgC = getContainer(ASSIGNMENTS);

                let responses = [];
                if (email) {
                    const { resources } = await rspC.items
                        .query(
                            {
                                query: 'SELECT * FROM c WHERE IS_DEFINED(c.email) AND LOWER(c.email) = @email',
                                parameters: [{ name: '@email', value: email }],
                            },
                            { enableCrossPartitionQuery: true }
                        )
                        .fetchAll();
                    responses = resources || [];
                }
                if (siteId) {
                    const { resources } = await rspC.items
                        .query(
                            {
                                query: 'SELECT * FROM c WHERE c.siteId = @siteId',
                                parameters: [{ name: '@siteId', value: String(siteId) }],
                            },
                            { enableCrossPartitionQuery: true }
                        )
                        .fetchAll();
                    const bySite = resources || [];
                    if (email) {
                        const ids = new Set(responses.map((r) => r.id));
                        bySite.forEach((r) => {
                            if (!ids.has(r.id)) responses.push(r);
                        });
                    } else {
                        responses = bySite;
                    }
                }

                const assignmentIds = [...new Set(responses.map((r) => r.assignmentId).filter(Boolean))];
                const assignments = [];
                for (const aid of assignmentIds) {
                    try {
                        const { resource } = await asgC.item(aid, aid).read();
                        if (resource) assignments.push(resource);
                    } catch (_) {}
                }

                // Also assignments that targeted this email
                if (email) {
                    const { resources: asgByEmail } = await asgC.items
                        .query(
                            {
                                query: 'SELECT * FROM c WHERE IS_DEFINED(c.targetEmail) AND LOWER(c.targetEmail) = @email',
                                parameters: [{ name: '@email', value: email }],
                            },
                            { enableCrossPartitionQuery: true }
                        )
                        .fetchAll();
                    (asgByEmail || []).forEach((a) => {
                        if (!assignments.find((x) => x.id === a.id)) assignments.push(a);
                    });
                }

                const payload = {
                    exportedAt: new Date().toISOString(),
                    criteria: { email: email || null, siteId: siteId || null },
                    counts: { responses: responses.length, assignments: assignments.length },
                    responses,
                    assignments,
                };

                await writeAudit(getContainer, generateId, {
                    action: 'export',
                    operator,
                    criteria: payload.criteria,
                    counts: payload.counts,
                });

                return { jsonBody: payload, headers: corsHeaders() };
            } catch (error) {
                return handleError(context, error, 'privacy/export');
            }
        },
    });

    // ---------- Erase / redact by email ----------
    app.http('privacyErase', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'privacy/erase',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            const keyFail = assertPrivacyKey(request);
            if (keyFail) return keyFail;

            try {
                await ensurePrivacyContainer(getCosmosClient, context);
                const body = await getBody(request);
                const email = normalizeEmail(body.email);
                const operator = body.operator || readHeader(request, 'X-Artemis-Operator') || 'unknown';
                const mode = String(body.mode || 'redact').toLowerCase(); // redact | delete

                if (!email) {
                    return { status: 400, jsonBody: { error: 'email is required' }, headers: corsHeaders() };
                }
                if (body.confirm !== true) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Set confirm: true to erase personal data for this email' },
                        headers: corsHeaders(),
                    };
                }

                const rspC = getContainer(RESPONSES);
                const asgC = getContainer(ASSIGNMENTS);
                const now = new Date().toISOString();

                const { resources: responses } = await rspC.items
                    .query(
                        {
                            query: 'SELECT * FROM c WHERE IS_DEFINED(c.email) AND LOWER(c.email) = @email',
                            parameters: [{ name: '@email', value: email }],
                        },
                        { enableCrossPartitionQuery: true }
                    )
                    .fetchAll();

                const { resources: assignments } = await asgC.items
                    .query(
                        {
                            query: 'SELECT * FROM c WHERE IS_DEFINED(c.targetEmail) AND LOWER(c.targetEmail) = @email',
                            parameters: [{ name: '@email', value: email }],
                        },
                        { enableCrossPartitionQuery: true }
                    )
                    .fetchAll();

                let responsesTouched = 0;
                let assignmentsTouched = 0;

                for (const r of responses || []) {
                    if (mode === 'delete') {
                        await rspC.item(r.id, r.id).delete();
                    } else {
                        await rspC.items.upsert({
                            ...r,
                            email: null,
                            displayName: null,
                            entraId: null,
                            answers: Array.isArray(r.answers)
                                ? r.answers.map((a) => ({
                                      ...a,
                                      value: a && a.value != null ? '[redacted]' : a?.value,
                                  }))
                                : [],
                            _privacyErasedAt: now,
                            _privacyErasedBy: operator,
                            updatedAt: now,
                        });
                    }
                    responsesTouched += 1;
                }

                for (const a of assignments || []) {
                    await asgC.items.upsert({
                        ...a,
                        targetEmail: null,
                        _privacyErasedAt: now,
                        _privacyErasedBy: operator,
                        updatedAt: now,
                    });
                    assignmentsTouched += 1;
                }

                const audit = await writeAudit(getContainer, generateId, {
                    action: 'erase',
                    mode,
                    operator,
                    criteria: { email },
                    counts: { responses: responsesTouched, assignments: assignmentsTouched },
                });

                return {
                    jsonBody: {
                        ok: true,
                        mode,
                        counts: { responses: responsesTouched, assignments: assignmentsTouched },
                        auditId: audit.id,
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'privacy/erase');
            }
        },
    });

    // ---------- Retention: purge archived survey responses ----------
    app.http('privacyRetentionPurge', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'privacy/retention/purge-archived',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            const keyFail = assertPrivacyKey(request);
            if (keyFail) return keyFail;

            try {
                await ensurePrivacyContainer(getCosmosClient, context);
                const body = await getBody(request);
                const operator = body.operator || readHeader(request, 'X-Artemis-Operator') || 'unknown';
                const defaultDays = parseInt(process.env.SURVEY_ARCHIVE_RETENTION_DAYS || '365', 10);
                const olderThanDays = Math.max(
                    1,
                    parseInt(body.olderThanDays != null ? body.olderThanDays : defaultDays, 10) || defaultDays
                );
                if (body.confirm !== true) {
                    return {
                        status: 400,
                        jsonBody: {
                            error: 'Set confirm: true to permanently delete archived survey responses',
                            olderThanDays,
                        },
                        headers: corsHeaders(),
                    };
                }

                const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
                const rspC = getContainer(RESPONSES);
                const { resources } = await rspC.items
                    .query(
                        {
                            query:
                                'SELECT * FROM c WHERE c._archived = true AND (c._archivedAt < @cutoff OR (NOT IS_DEFINED(c._archivedAt) AND c.submittedAt < @cutoff))',
                            parameters: [{ name: '@cutoff', value: cutoff }],
                        },
                        { enableCrossPartitionQuery: true }
                    )
                    .fetchAll();

                let deleted = 0;
                for (const r of resources || []) {
                    try {
                        await rspC.item(r.id, r.id).delete();
                        deleted += 1;
                    } catch (_) {}
                }

                const audit = await writeAudit(getContainer, generateId, {
                    action: 'retention_purge_archived',
                    operator,
                    olderThanDays,
                    cutoff,
                    counts: { deleted },
                });

                return {
                    jsonBody: { ok: true, olderThanDays, cutoff, deleted, auditId: audit.id },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'privacy/retention/purge-archived');
            }
        },
    });

    // ---------- Audit log list ----------
    app.http('privacyAudit', {
        methods: ['GET', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'privacy/audit',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            const keyFail = assertPrivacyKey(request);
            if (keyFail) return keyFail;

            try {
                await ensurePrivacyContainer(getCosmosClient, context);
                const c = getContainer(AUDIT_CONTAINER);
                const { resources } = await c.items
                    .query(
                        { query: 'SELECT TOP 100 * FROM c ORDER BY c.createdAt DESC' },
                        { enableCrossPartitionQuery: true }
                    )
                    .fetchAll();
                return { jsonBody: resources || [], headers: corsHeaders() };
            } catch (error) {
                if (isMissingContainer(error)) {
                    return { jsonBody: [], headers: corsHeaders() };
                }
                return handleError(context, error, 'privacy/audit');
            }
        },
    });
}

function isMissingContainer(error) {
    const code = error?.code || error?.statusCode;
    const msg = String(error?.message || '');
    return code === 404 || /Owner resource does not exist/i.test(msg);
}

module.exports = { registerPrivacyRoutes, AUDIT_CONTAINER };
