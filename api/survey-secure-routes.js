/**
 * Secure site-survey surface (staff PII):
 *  - Opaque invite tokens (hash at rest)
 *  - Public load / save-draft / submit by token only
 *  - Bulk send to site emails
 *  - Ops notification inbox
 *
 * Does not change NASA/CHAOS routes.
 */
const {
    mintSurveyToken,
    hashSurveyToken,
    defaultExpiresAt,
    isExpired,
    redactAssignment,
    buildInviteUrl,
    DEFAULT_TTL_DAYS,
} = require('./lib/survey-tokens');
const {
    answersToPrefillMap,
    findLatestLiveResponse,
    writeSurveyResponse,
    normalizeRole,
    sortByIsoDesc,
} = require('./lib/survey-response-service');
const {
    deliverSurveyEmail,
    inviteEmailCopy,
    opsNotifyCopy,
    emailProviderStatus,
} = require('./lib/survey-email');

const ASSIGNMENTS = 'site-survey-assignments';
const DEFINITIONS = 'site-survey-definitions';
const NOTIFICATIONS = 'site-survey-notifications';
const SITES = 'sites';
const SITE_STAFF = 'site-staff';

/** Simple per-instance rate limit (best-effort; use Front Door for hard limits). */
const rateBuckets = new Map();

function corsHeaders() {
    const allowed = (process.env.SURVEY_CORS_ORIGINS || process.env.STATIC_WEB_APP_URL || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const origin = allowed.length === 1 ? allowed[0] : '*';
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Artemis-Operator',
        'Cache-Control': 'no-store',
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
        if (request.headers) return request.headers[name] || request.headers[name.toLowerCase()];
    } catch (_) {}
    return null;
}

function clientIp(request) {
    return (
        readHeader(request, 'x-forwarded-for')?.split(',')[0]?.trim() ||
        readHeader(request, 'x-client-ip') ||
        'unknown'
    );
}

function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
        bucket = { start: now, count: 0 };
        rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
}

function roleLabel(role) {
    const r = normalizeRole(role);
    if (r === 'pi') return 'PI';
    if (r === 'coordinator') return 'Coordinator';
    return role || 'Staff';
}

function publicQuestions(def) {
    const questions = Array.isArray(def?.questions) ? def.questions : [];
    return questions.map((q, idx) => ({
        id: q.id || `q_${idx}`,
        label: q.label || q.title || `Question ${idx + 1}`,
        type: (q.type || 'text').toLowerCase(),
        required: !!q.required,
        options: Array.isArray(q.options) ? q.options : undefined,
        logic: q.logic || undefined,
        sensitivity: q.sensitivity === 'pii' || q.sensitivity === 'phi' ? q.sensitivity : 'none',
        defaultValue: q.defaultValue,
    }));
}

async function ensureNotificationsContainer(getCosmosClient) {
    const { database } = getCosmosClient();
    await database.containers.createIfNotExists({
        id: NOTIFICATIONS,
        partitionKey: { paths: ['/id'] },
    });
}

async function writeNotification(deps, entry) {
    const { getContainer, getCosmosClient, generateId } = deps;
    try {
        await ensureNotificationsContainer(getCosmosClient);
    } catch (_) {
        /* may already exist */
    }
    const doc = {
        id: generateId(),
        type: 'siteSurveyNotification',
        createdAt: new Date().toISOString(),
        read: false,
        ...entry,
    };
    try {
        const c = getContainer(NOTIFICATIONS);
        await c.items.create(doc);
    } catch (e) {
        console.warn('survey notification write failed', e.message);
    }
    return doc;
}

async function findAssignmentByToken(getContainer, rawToken) {
    const hash = hashSurveyToken(rawToken);
    const c = getContainer(ASSIGNMENTS);
    const { resources } = await c.items
        .query(
            {
                query: 'SELECT * FROM c WHERE c.tokenHash = @h',
                parameters: [{ name: '@h', value: hash }],
            },
            { enableCrossPartitionQuery: true }
        )
        .fetchAll();
    return resources && resources[0] ? resources[0] : null;
}

function assertTokenUsable(assignment) {
    if (!assignment) return { status: 404, error: 'Invalid or unknown survey link.' };
    if (assignment.revokedAt) return { status: 410, error: 'This survey link was revoked. Ask operations for a new link.' };
    if (isExpired(assignment.expiresAt)) {
        return { status: 410, error: 'This survey link has expired. Ask operations to resend.' };
    }
    return null;
}

async function resolveSiteName(getContainer, siteId) {
    try {
        const read = await getContainer(SITES).item(siteId, siteId).read();
        return read.resource?.name || siteId;
    } catch (_) {
        return siteId;
    }
}

async function resolveRecipientEmail(getContainer, siteId, targetRole) {
    const role = normalizeRole(targetRole);
    try {
        const siteRead = await getContainer(SITES).item(siteId, siteId).read();
        const site = siteRead.resource;
        if (site) {
            if (role === 'pi' && site.piEmail) return String(site.piEmail).trim();
            if (role === 'coordinator' && site.siteCoordinatorEmail) {
                return String(site.siteCoordinatorEmail).trim();
            }
        }
    } catch (_) {}

    try {
        const { resources } = await getContainer(SITE_STAFF)
            .items.query(
                {
                    query:
                        'SELECT * FROM c WHERE c.siteId = @siteId AND LOWER(c.role) = @role',
                    parameters: [
                        { name: '@siteId', value: String(siteId) },
                        { name: '@role', value: role === 'pi' ? 'pi' : 'coordinator' },
                    ],
                },
                { enableCrossPartitionQuery: true }
            )
            .fetchAll();
        const withEmail = (resources || []).find((s) => s && s.email);
        if (withEmail?.email) return String(withEmail.email).trim();
        // Staff roles may be stored as Investigator / Coordinator labels
        const { resources: all } = await getContainer(SITE_STAFF)
            .items.query(
                {
                    query: 'SELECT * FROM c WHERE c.siteId = @siteId',
                    parameters: [{ name: '@siteId', value: String(siteId) }],
                },
                { enableCrossPartitionQuery: true }
            )
            .fetchAll();
        const match = (all || []).find((s) => {
            const r = String(s.role || s.title || '').toLowerCase();
            if (!s.email) return false;
            if (role === 'pi') return /pi|investigator|investigator 1/.test(r);
            return /coord/.test(r);
        });
        if (match?.email) return String(match.email).trim();
    } catch (_) {}

    return null;
}

function buildPublicPayload({ assignment, definition, siteName, prior, draftAnswers }) {
    const prefill = {
        ...(definition?.defaultValues || {}),
        ...answersToPrefillMap(prior?.answers),
        ...answersToPrefillMap(draftAnswers || assignment.draftAnswers),
    };
    const hasPrior = Boolean(prior) || Boolean(assignment.draftAnswers?.length);
    const status = String(assignment.status || '').toLowerCase();
    return {
        siteDisplayName: siteName,
        privacyContact: process.env.PRIVACY_CONTACT_EMAIL || null,
        assignment: {
            status,
            targetRole: assignment.targetRole,
            expiresAt: assignment.expiresAt || null,
            allowResubmit: assignment.allowResubmit !== false,
            openedAt: assignment.openedAt || null,
            submittedAt: assignment.submittedAt || null,
            draftSavedAt: assignment.draftSavedAt || null,
        },
        survey: {
            id: definition.id,
            title: definition.title || 'Site survey',
            description: definition.description || '',
            questions: publicQuestions(definition),
        },
        prefill,
        hasPrior,
        alreadySubmitted: status === 'submitted',
    };
}

/**
 * Attach invite token fields to a new/updated assignment (mutates doc).
 * Returns { raw, inviteUrl } for one-time client display.
 */
function attachInviteToken(assignment, { expiresInDays, baseUrl } = {}) {
    const { raw, hash, prefix } = mintSurveyToken();
    assignment.tokenHash = hash;
    assignment.tokenPrefix = prefix;
    assignment.expiresAt = assignment.expiresAt || defaultExpiresAt(expiresInDays || DEFAULT_TTL_DAYS);
    assignment.allowResubmit = assignment.allowResubmit !== false;
    assignment.inviteCreatedAt = new Date().toISOString();
    const inviteUrl = baseUrl ? buildInviteUrl(baseUrl, raw) : null;
    return { raw, inviteUrl, prefix };
}

function registerSurveySecureRoutes(app, deps) {
    const {
        getContainer,
        getCosmosClient,
        handleError,
        generateId,
        validateSurveyResponsesSchema,
        validateSurveyAssignmentsSchema,
    } = deps;

    const serviceDeps = { getContainer, generateId, validateSurveyResponsesSchema };

    // ---------- Public: load survey by token ----------
    app.http('publicSiteSurveyGet', {
        methods: ['GET', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'public/site-survey',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            const ip = clientIp(request);
            if (!rateLimit(`get:${ip}`, 60, 60_000)) {
                return { status: 429, jsonBody: { error: 'Too many requests' }, headers: corsHeaders() };
            }

            try {
                const raw = readQueryParam(request, 't') || readQueryParam(request, 'token');
                if (!raw) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Missing survey token. Use the link from your invitation email.' },
                        headers: corsHeaders(),
                    };
                }

                const assignment = await findAssignmentByToken(getContainer, raw);
                const bad = assertTokenUsable(assignment);
                if (bad) {
                    return { status: bad.status, jsonBody: { error: bad.error }, headers: corsHeaders() };
                }

                let definition = null;
                try {
                    const defRead = await getContainer(DEFINITIONS)
                        .item(assignment.surveyId, assignment.surveyId)
                        .read();
                    definition = defRead.resource;
                } catch (_) {
                    definition = null;
                }
                if (!definition) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Survey definition was not found.' },
                        headers: corsHeaders(),
                    };
                }

                // Mark opened (first open only; never reopen past submitted)
                if (!assignment.openedAt) {
                    try {
                        const now = new Date().toISOString();
                        const next = {
                            ...assignment,
                            openedAt: now,
                            updatedAt: now,
                            status:
                                String(assignment.status || '').toLowerCase() === 'submitted'
                                    ? 'submitted'
                                    : 'opened',
                        };
                        await getContainer(ASSIGNMENTS).items.upsert(next);
                        Object.assign(assignment, next);
                    } catch (_) {}
                }

                const siteName = await resolveSiteName(getContainer, assignment.siteId);
                const prior = await findLatestLiveResponse(getContainer, {
                    siteId: assignment.siteId,
                    surveyId: assignment.surveyId,
                    targetRole: assignment.targetRole,
                });

                return {
                    jsonBody: buildPublicPayload({ assignment, definition, siteName, prior }),
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'public/site-survey GET');
            }
        },
    });

    // ---------- Public: save draft or submit ----------
    app.http('publicSiteSurveyPost', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'public/site-survey',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            const ip = clientIp(request);
            if (!rateLimit(`post:${ip}`, 30, 60_000)) {
                return { status: 429, jsonBody: { error: 'Too many requests' }, headers: corsHeaders() };
            }

            try {
                const body = await request.json();
                const raw = body?.t || body?.token;
                const action = String(body?.action || 'submit').toLowerCase();
                if (!raw) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Missing survey token' },
                        headers: corsHeaders(),
                    };
                }

                const assignment = await findAssignmentByToken(getContainer, raw);
                const bad = assertTokenUsable(assignment);
                if (bad) {
                    return { status: bad.status, jsonBody: { error: bad.error }, headers: corsHeaders() };
                }

                const alreadySubmitted =
                    String(assignment.status || '').toLowerCase() === 'submitted';
                if (alreadySubmitted && assignment.allowResubmit === false && action === 'submit') {
                    return {
                        status: 409,
                        jsonBody: { error: 'This survey was already submitted and cannot be updated.' },
                        headers: corsHeaders(),
                    };
                }

                const answers = Array.isArray(body.answers) ? body.answers : [];

                if (action === 'draft' || action === 'save') {
                    const result = await writeSurveyResponse(serviceDeps, {
                        assignment,
                        answers,
                        email: body.email,
                        displayName: body.displayName,
                        isDraft: true,
                    });
                    return {
                        status: 200,
                        jsonBody: {
                            ok: true,
                            draft: true,
                            draftSavedAt: result.assignment?.draftSavedAt,
                        },
                        headers: corsHeaders(),
                    };
                }

                // Light server-side required check against definition
                let definition = null;
                try {
                    const defRead = await getContainer(DEFINITIONS)
                        .item(assignment.surveyId, assignment.surveyId)
                        .read();
                    definition = defRead.resource;
                } catch (_) {}
                if (definition?.questions?.length) {
                    const byId = new Map(answers.map((a) => [String(a.questionId), a]));
                    const missing = [];
                    for (const q of definition.questions) {
                        if (!q.required) continue;
                        // Skip conditional questions that aren't visible (client marks skipped)
                        const a = byId.get(String(q.id));
                        if (a?.skipped) continue;
                        if (!a || String(a.value ?? '').trim() === '') {
                            missing.push(q.label || q.title || q.id);
                        }
                    }
                    if (missing.length) {
                        return {
                            status: 400,
                            jsonBody: {
                                error: 'Please complete required questions',
                                missing,
                            },
                            headers: corsHeaders(),
                        };
                    }
                }

                const result = await writeSurveyResponse(serviceDeps, {
                    assignment,
                    answers,
                    email: body.email || assignment.targetEmail,
                    displayName: body.displayName,
                    isDraft: false,
                });

                const siteName = await resolveSiteName(getContainer, assignment.siteId);
                let surveyTitle = assignment.surveyId;
                try {
                    const defRead = await getContainer(DEFINITIONS)
                        .item(assignment.surveyId, assignment.surveyId)
                        .read();
                    surveyTitle = defRead.resource?.title || surveyTitle;
                } catch (_) {}

                const statusWord = result.resubmitted ? 'updated' : 'submitted';
                await writeNotification(deps, {
                    kind: result.resubmitted ? 'survey_resubmitted' : 'survey_submitted',
                    assignmentId: assignment.id,
                    surveyId: assignment.surveyId,
                    siteId: assignment.siteId,
                    siteName,
                    surveyTitle,
                    targetRole: assignment.targetRole,
                    responseId: result.resource?.id,
                    summary: `${siteName} · ${roleLabel(assignment.targetRole)} · ${surveyTitle}`,
                });

                // Optional ops email/webhook (no answer payloads)
                const notifyTo = process.env.SURVEY_OPS_NOTIFY_EMAIL;
                if (notifyTo) {
                    const copy = opsNotifyCopy({
                        siteName,
                        surveyTitle,
                        roleLabel: roleLabel(assignment.targetRole),
                        status: statusWord,
                    });
                    await deliverSurveyEmail({
                        to: notifyTo,
                        subject: copy.subject,
                        text: copy.text,
                        meta: { kind: 'ops_notify', assignmentId: assignment.id },
                    });
                }

                return {
                    status: result.created ? 201 : 200,
                    jsonBody: {
                        ok: true,
                        resubmitted: result.resubmitted,
                        responseId: result.resource?.id,
                        confirmationCode: String(result.resource?.id || '')
                            .slice(-8)
                            .toUpperCase(),
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'public/site-survey POST');
            }
        },
    });

    // ---------- Ops: bulk send ----------
    app.http('siteSurveySend', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'site-survey-send',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                const body = await request.json();
                const surveyId = body?.surveyId;
                const siteIds = Array.isArray(body?.siteIds)
                    ? body.siteIds.map(String).filter(Boolean)
                    : body?.siteId
                      ? [String(body.siteId)]
                      : [];
                const rolesRaw = Array.isArray(body?.targetRoles)
                    ? body.targetRoles
                    : [body?.targetRole || 'pi'];
                const targetRoles = [...new Set(rolesRaw.map(normalizeRole).filter(Boolean))];
                const expiresInDays = body?.expiresInDays || DEFAULT_TTL_DAYS;
                const baseUrl = String(body?.baseUrl || '').replace(/\/$/, '');
                const sendEmail = body?.sendEmail !== false;
                const operator =
                    body?.operator ||
                    readHeader(request, 'X-Artemis-Operator') ||
                    'unknown';

                if (!surveyId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'surveyId is required' },
                        headers: corsHeaders(),
                    };
                }
                if (!siteIds.length) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Select at least one site' },
                        headers: corsHeaders(),
                    };
                }
                if (!baseUrl) {
                    return {
                        status: 400,
                        jsonBody: { error: 'baseUrl is required to build invite links' },
                        headers: corsHeaders(),
                    };
                }

                let definition = null;
                try {
                    const defRead = await getContainer(DEFINITIONS).item(surveyId, surveyId).read();
                    definition = defRead.resource;
                } catch (_) {}
                if (!definition) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Survey definition not found' },
                        headers: corsHeaders(),
                    };
                }

                const asgC = getContainer(ASSIGNMENTS);
                const results = [];
                const now = new Date().toISOString();

                for (const siteId of siteIds) {
                    const siteName = await resolveSiteName(getContainer, siteId);
                    for (const targetRole of targetRoles) {
                        const email =
                            (body?.emailOverrides && body.emailOverrides[`${siteId}:${targetRole}`]) ||
                            (await resolveRecipientEmail(getContainer, siteId, targetRole));

                        const assignment = {
                            id: generateId(),
                            surveyId,
                            siteId,
                            targetRole,
                            targetEmail: email || undefined,
                            status: 'sent',
                            allowResubmit: true,
                            createdAt: now,
                            updatedAt: now,
                            lastSentAt: now,
                            sendCount: 1,
                            sentBy: operator,
                        };
                        const { raw, inviteUrl } = attachInviteToken(assignment, {
                            expiresInDays,
                            baseUrl,
                        });
                        if (validateSurveyAssignmentsSchema) {
                            validateSurveyAssignmentsSchema(assignment);
                        }
                        await asgC.items.create(assignment);

                        let emailResult = { ok: false, mode: 'manual', error: 'skipped' };
                        if (sendEmail && email) {
                            const copy = inviteEmailCopy({
                                siteName,
                                roleLabel: roleLabel(targetRole),
                                inviteUrl,
                                expiresAt: assignment.expiresAt,
                            });
                            emailResult = await deliverSurveyEmail({
                                to: email,
                                subject: copy.subject,
                                text: copy.text,
                                html: copy.html,
                                meta: {
                                    assignmentId: assignment.id,
                                    siteId,
                                    surveyId,
                                    targetRole,
                                },
                            });
                        } else if (!email) {
                            emailResult = { ok: false, mode: 'manual', error: 'missing_recipient' };
                        }

                        await writeNotification(deps, {
                            kind: 'survey_sent',
                            assignmentId: assignment.id,
                            surveyId,
                            siteId,
                            siteName,
                            surveyTitle: definition.title,
                            targetRole,
                            targetEmail: email || null,
                            emailMode: emailResult.mode,
                            emailOk: !!emailResult.ok,
                            summary: `Sent · ${siteName} · ${roleLabel(targetRole)}`,
                            operator,
                        });

                        results.push({
                            assignmentId: assignment.id,
                            siteId,
                            siteName,
                            targetRole,
                            targetEmail: email || null,
                            inviteUrl,
                            tokenPrefix: assignment.tokenPrefix,
                            expiresAt: assignment.expiresAt,
                            email: emailResult,
                        });
                    }
                }

                return {
                    status: 201,
                    jsonBody: {
                        ok: true,
                        count: results.length,
                        surveyId,
                        surveyTitle: definition.title,
                        emailProvider: emailProviderStatus(),
                        results,
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'site-survey-send');
            }
        },
    });

    // ---------- Ops: rotate / resend token for one assignment ----------
    app.http('siteSurveyResend', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'site-survey-assignments/{id}/resend',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                const id =
                    request.params?.id ||
                    (request.url || '').split('/').filter(Boolean).pop()?.split('?')[0];
                const body = await request.json().catch(() => ({}));
                const baseUrl = String(body?.baseUrl || '').replace(/\/$/, '');
                if (!id || !baseUrl) {
                    return {
                        status: 400,
                        jsonBody: { error: 'assignment id and baseUrl are required' },
                        headers: corsHeaders(),
                    };
                }

                let assignment = null;
                try {
                    const read = await getContainer(ASSIGNMENTS).item(id, id).read();
                    assignment = read.resource;
                } catch (_) {}
                if (!assignment) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Assignment not found' },
                        headers: corsHeaders(),
                    };
                }

                const now = new Date().toISOString();
                assignment.revokedAt = undefined;
                assignment.updatedAt = now;
                assignment.lastSentAt = now;
                assignment.sendCount = (assignment.sendCount || 0) + 1;
                if (body.expiresInDays) {
                    assignment.expiresAt = defaultExpiresAt(body.expiresInDays);
                } else if (!assignment.expiresAt || isExpired(assignment.expiresAt)) {
                    assignment.expiresAt = defaultExpiresAt(DEFAULT_TTL_DAYS);
                }

                const { inviteUrl } = attachInviteToken(assignment, {
                    expiresInDays: body.expiresInDays,
                    baseUrl,
                });
                // attachInviteToken always sets expiresAt — preserve if we set above
                await getContainer(ASSIGNMENTS).items.upsert(assignment);

                const siteName = await resolveSiteName(getContainer, assignment.siteId);
                const email = assignment.targetEmail ||
                    (await resolveRecipientEmail(getContainer, assignment.siteId, assignment.targetRole));

                let emailResult = { ok: false, mode: 'manual' };
                if (body.sendEmail !== false && email) {
                    assignment.targetEmail = email;
                    const copy = inviteEmailCopy({
                        siteName,
                        roleLabel: roleLabel(assignment.targetRole),
                        inviteUrl,
                        expiresAt: assignment.expiresAt,
                    });
                    emailResult = await deliverSurveyEmail({
                        to: email,
                        subject: copy.subject,
                        text: copy.text,
                        html: copy.html,
                        meta: { assignmentId: assignment.id, resend: true },
                    });
                    await getContainer(ASSIGNMENTS).items.upsert({
                        ...assignment,
                        targetEmail: email,
                    });
                }

                return {
                    jsonBody: {
                        ok: true,
                        assignment: redactAssignment(assignment),
                        inviteUrl,
                        targetEmail: email || null,
                        email: emailResult,
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'site-survey-resend');
            }
        },
    });

    // ---------- Ops: notification inbox ----------
    app.http('siteSurveyNotifications', {
        methods: ['GET', 'POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'site-survey-notifications/{id?}',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                await ensureNotificationsContainer(getCosmosClient);
                const c = getContainer(NOTIFICATIONS);

                if (request.method === 'GET') {
                    const unreadOnly = String(readQueryParam(request, 'unread') || '') === '1';
                    const { resources } = await c.items
                        .query(
                            {
                                query: unreadOnly
                                    ? 'SELECT * FROM c WHERE c.read != true ORDER BY c.createdAt DESC'
                                    : 'SELECT TOP 100 * FROM c ORDER BY c.createdAt DESC',
                            },
                            { enableCrossPartitionQuery: true }
                        )
                        .fetchAll();
                    const rows = sortByIsoDesc(resources || [], ['createdAt']);
                    return { jsonBody: rows.slice(0, 100), headers: corsHeaders() };
                }

                // POST mark read: { ids: [...] } or { id }
                const body = await request.json();
                const ids = Array.isArray(body?.ids)
                    ? body.ids
                    : body?.id
                      ? [body.id]
                      : request.params?.id
                        ? [request.params.id]
                        : [];
                const updated = [];
                for (const nid of ids) {
                    try {
                        const read = await c.item(nid, nid).read();
                        if (!read.resource) continue;
                        const next = {
                            ...read.resource,
                            read: true,
                            readAt: new Date().toISOString(),
                        };
                        const { resource } = await c.items.upsert(next);
                        updated.push(resource);
                    } catch (_) {}
                }
                return { jsonBody: { ok: true, updated: updated.length }, headers: corsHeaders() };
            } catch (error) {
                return handleError(context, error, 'site-survey-notifications');
            }
        },
    });
}

module.exports = {
    registerSurveySecureRoutes,
    attachInviteToken,
    redactAssignment,
    buildInviteUrl,
    NOTIFICATIONS,
};
