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
    hashSurveyPassword,
    verifySurveyPassword,
    defaultExpiresAt,
    isExpired,
    isPastHardExpiry,
    clampExpiresInDays,
    redactAssignment,
    buildInviteUrl,
    DEFAULT_TTL_DAYS,
    EXPIRY_GRACE_DAYS,
} = require('./lib/survey-tokens');
const {
    answersToPrefillMap,
    buildPrefillMapForQuestions,
    buildSiteRecordPrefill,
    findLatestLiveResponse,
    findSiteRoleLiveResponses,
    findSiteLiveResponses,
    resolveRelatedSiteIds,
    resolvePublicSurveyQuestions,
    compareSurveyResponses,
    writeSurveyResponse,
    normalizeRole,
    sortByIsoDesc,
    GENERAL_FEASIBILITY_SURVEY_ID,
    GENERAL_FEASIBILITY_SHORT_SURVEY_ID,
    normalizeGeneralFeasibilityVariant,
    isGeneralFeasibilitySurveyId,
} = require('./lib/survey-response-service');
const {
    deliverSurveyEmail,
    inviteEmailCopy,
    opsNotifyCopy,
    emailProviderStatus,
} = require('./lib/survey-email');
const {
    normalizeIncomingAttachments,
    parseCcList,
    persistAttachments,
    loadAttachmentDocs,
    publicAttachmentMeta,
    emailAttachmentPayload,
    MAX_FILES,
    MAX_BYTES,
} = require('./lib/survey-attachments');

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
        'Access-Control-Allow-Headers':
            'Content-Type,Authorization,X-Artemis-Operator,X-Survey-Password',
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
    if (r === 'coordinator') return 'Primary contact';
    return role || 'Staff';
}

/** Short role token for email subjects: MYTX… || Feasibility Survey || PI */
function roleSubjectLabel(role) {
    const r = normalizeRole(role);
    if (r === 'pi') return 'PI';
    if (r === 'coordinator') return 'SC';
    return roleLabel(role);
}

function assignmentRequiresPassword(assignment) {
    return Boolean(assignment && assignment.passwordHash);
}

function readProvidedPassword(request, body) {
    const fromBody = body?.password ?? body?.surveyPassword ?? body?.emailPassword;
    if (fromBody != null && String(fromBody).length) return String(fromBody);
    const fromHeader = readHeader(request, 'X-Survey-Password');
    if (fromHeader) return String(fromHeader);
    const fromQuery = readQueryParam(request, 'password');
    if (fromQuery) return String(fromQuery);
    return '';
}

function passwordOk(assignment, providedPassword) {
    if (!assignmentRequiresPassword(assignment)) return true;
    return verifySurveyPassword(providedPassword, assignment.passwordHash);
}

function passwordGateFailure(assignment, providedPassword) {
    if (passwordOk(assignment, providedPassword)) return null;
    return {
        status: 401,
        jsonBody: {
            error: 'password_required',
            requiresPassword: true,
            message: 'Enter the survey password from your invitation email.',
        },
        headers: corsHeaders(),
    };
}

function publicQuestionsFromList(questions) {
    const list = Array.isArray(questions) ? questions : [];
    return list.map((q, idx) => {
        const hasBranch = !!(q.logic && q.logic.showIf && q.logic.showIf.questionId);
        return {
            id: q.id || `q_${idx}`,
            label: q.label || q.title || `Question ${idx + 1}`,
            type: (q.type || 'text').toLowerCase(),
            // Default required; branching questions are still required when visible only
            required: q.required !== false,
            branching: hasBranch,
            options: Array.isArray(q.options) ? q.options : undefined,
            logic: q.logic || undefined,
            libraryQuestionId: q.libraryQuestionId || undefined,
            fromGeneralFeasibility: q._fromGeneralFeasibility === true,
            sensitivity: q.sensitivity === 'pii' || q.sensitivity === 'phi' ? q.sensitivity : 'none',
            defaultValue: q.defaultValue,
            // Section / paging metadata for the public multi-page form
            category: q.category || q.section || undefined,
            section: q.section || q.category || undefined,
            help: q.help || q.context || q.description || undefined,
            maxStars: q.maxStars || q.max || undefined,
            docxNum: typeof q.docxNum === 'number' ? q.docxNum : undefined,
        };
    });
}

/** Group questions into ordered section pages for the public form. */
function buildSurveyPages(questions) {
    const list = Array.isArray(questions) ? questions : [];
    const pages = [];
    list.forEach((q, idx) => {
        const key = String(q.category || q.section || '').trim() || 'Questions';
        if (!pages.length || pages[pages.length - 1].key !== key) {
            pages.push({
                key,
                title: key.replace(/^SECTION\s+\d+\s*:\s*/i, '').trim() || key,
                questionIds: [],
                indexes: [],
            });
        }
        pages[pages.length - 1].questionIds.push(q.id || `q_${idx}`);
        pages[pages.length - 1].indexes.push(idx);
    });
    return pages;
}

function publicQuestions(def) {
    return publicQuestionsFromList(def?.questions);
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
    if (!resources || !resources.length) return null;
    // Prefer newest invite if any duplicate hashes ever exist
    return sortByIsoDesc(resources, ['inviteCreatedAt', 'updatedAt', 'createdAt'])[0];
}

function assertTokenUsable(assignment) {
    if (!assignment) return { status: 404, error: 'Invalid or unknown survey link.' };
    if (assignment.revokedAt) {
        return { status: 410, error: 'This survey link was revoked. Ask operations for a new link.' };
    }
    // Soft expiry at expiresAt is advisory. Hard cut = expiresAt + EXPIRY_GRACE_DAYS.
    // Sites mid-form (or late to open) keep working until the hard cut; then Resend.
    if (isPastHardExpiry(assignment.expiresAt, EXPIRY_GRACE_DAYS)) {
        return {
            status: 410,
            error: 'This survey link has expired. Ask operations to resend a new link.',
        };
    }
    return null;
}

async function resolveSiteName(getContainer, siteId) {
    try {
        const read = await getContainer(SITES).item(siteId, siteId).read();
        if (read.resource?.name) return read.resource.name;
    } catch (_) {}
    try {
        const read = await getContainer('legacy-sites').item(siteId, siteId).read();
        if (read.resource?.name) return read.resource.name;
    } catch (_) {}
    return siteId;
}

async function loadSiteDoc(getContainer, siteId) {
    try {
        const read = await getContainer(SITES).item(siteId, siteId).read();
        if (read.resource) return read.resource;
    } catch (_) {}
    try {
        const read = await getContainer('legacy-sites').item(siteId, siteId).read();
        if (read.resource) {
            const leg = read.resource;
            return {
                ...leg,
                siteCoordinator: leg.siteCoordinator || leg.coordinator || '',
                siteCoordinatorEmail: leg.siteCoordinatorEmail || leg.coordinatorEmail || '',
                pi: leg.pi || leg.piName || '',
                _fromLegacy: true,
            };
        }
    } catch (_) {}
    return null;
}

async function loadStaffForRole(getContainer, siteId, targetRole) {
    const role = normalizeRole(targetRole);
    try {
        const { resources } = await getContainer(SITE_STAFF)
            .items.query(
                {
                    query: 'SELECT * FROM c WHERE c.siteId = @siteId',
                    parameters: [{ name: '@siteId', value: String(siteId) }],
                },
                { enableCrossPartitionQuery: true }
            )
            .fetchAll();
        const list = resources || [];
        const match = list.find((s) => {
            const r = String(s.role || s.title || '').toLowerCase();
            if (role === 'pi') return /^(pi)\b|investigator/.test(r);
            return /coord/.test(r);
        });
        return match || null;
    } catch (_) {
        return null;
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
        const legRead = await getContainer('legacy-sites').item(siteId, siteId).read();
        const leg = legRead.resource;
        if (leg) {
            if (role === 'pi' && leg.piEmail) return String(leg.piEmail).trim();
            const coordEmail = leg.siteCoordinatorEmail || leg.coordinatorEmail;
            if (role === 'coordinator' && coordEmail) return String(coordEmail).trim();
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

function buildPublicPayload({
    assignment,
    definition,
    siteName,
    prior,
    draftAnswers,
    siteRoleResponses,
    questions,
    delta,
    siteDoc = null,
    coordinatorStaff = null,
    piStaff = null,
    attachments = [],
}) {
    const qList = Array.isArray(questions) ? questions : definition?.questions;
    const sitePrefill = buildSiteRecordPrefill(qList, siteDoc, {
        coordinatorStaff,
        piStaff,
    });
    // Cross-survey first (label / libraryQuestionId / gen-feas ids), then same-survey ids, then draft.
    const crossPrefill = buildPrefillMapForQuestions(qList, siteRoleResponses || (prior ? [prior] : []), {
        preferRole: assignment?.targetRole,
    });
    const prefill = {
        ...(definition?.defaultValues || {}),
        ...sitePrefill,
        ...crossPrefill,
        ...answersToPrefillMap(prior?.answers),
        ...answersToPrefillMap(draftAnswers || assignment.draftAnswers),
    };
    const hasPrior =
        Boolean(prior) ||
        Boolean(assignment.draftAnswers?.length) ||
        Object.keys(crossPrefill).length > 0 ||
        Object.keys(sitePrefill).length > 0;
    const status = String(assignment.status || '').toLowerCase();
    const publicQuestions = publicQuestionsFromList(qList);
    return {
        siteDisplayName: siteName,
        privacyContact:
            process.env.PRIVACY_CONTACT_EMAIL ||
            process.env.SURVEY_EMAIL_FROM ||
            'siteprofiles@oraclinical.com',
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
            questions: publicQuestions,
            pages: buildSurveyPages(publicQuestions),
            includesGeneralFeasibility:
                !isGeneralFeasibilitySurveyId(definition.id) &&
                normalizeGeneralFeasibilityVariant(assignment?.generalFeasibilityVariant) !== 'none',
            generalFeasibilityVariant: normalizeGeneralFeasibilityVariant(
                assignment?.generalFeasibilityVariant ?? 'long'
            ),
        },
        attachments: publicAttachmentMeta(attachments),
        requiresPassword: assignmentRequiresPassword(assignment),
        locked: false,
        prefill,
        hasPrior,
        alreadySubmitted: status === 'submitted',
        delta: delta || null,
    };
}

function buildLockedPublicPayload({ assignment, definition, siteName }) {
    const status = String(assignment?.status || '').toLowerCase();
    return {
        locked: true,
        requiresPassword: true,
        siteDisplayName: siteName,
        privacyContact:
            process.env.PRIVACY_CONTACT_EMAIL ||
            process.env.SURVEY_EMAIL_FROM ||
            'siteprofiles@oraclinical.com',
        assignment: {
            status,
            targetRole: assignment?.targetRole,
            expiresAt: assignment?.expiresAt || null,
            allowResubmit: assignment?.allowResubmit !== false,
        },
        survey: {
            id: definition?.id,
            title: definition?.title || 'Site survey',
            description: definition?.description || '',
            questions: [],
            pages: [],
        },
        attachments: [],
        prefill: {},
        hasPrior: false,
        alreadySubmitted: status === 'submitted',
        delta: null,
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

    // Azure Functions host cannot register two HTTP functions on the same route.
    // GET + POST must share one app.http registration (otherwise production returns empty 404).
    const handlePublicSiteSurveyGet = async (request, context) => {
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

            const siteNameEarly = await resolveSiteName(getContainer, assignment.siteId);
            const providedPw = readProvidedPassword(request, null);
            if (!passwordOk(assignment, providedPw)) {
                return {
                    jsonBody: buildLockedPublicPayload({
                        assignment,
                        definition,
                        siteName: siteNameEarly,
                    }),
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

            const siteName = siteNameEarly;
            const siteDoc = await loadSiteDoc(getContainer, assignment.siteId);
            const coordinatorStaff = await loadStaffForRole(getContainer, assignment.siteId, 'coordinator');
            const piStaff = await loadStaffForRole(getContainer, assignment.siteId, 'pi');
            const relatedSiteIds = await resolveRelatedSiteIds(getContainer, assignment.siteId);
            const questions = await resolvePublicSurveyQuestions(getContainer, definition, {
                generalFeasibilityVariant: assignment.generalFeasibilityVariant || 'long',
            });

            const prior = await findLatestLiveResponse(getContainer, {
                siteId: assignment.siteId,
                surveyId: assignment.surveyId,
                targetRole: assignment.targetRole,
            });

            let siteResponses = [];
            try {
                siteResponses = await findSiteLiveResponses(getContainer, {
                    siteIds: relatedSiteIds,
                });
            } catch (_) {
                try {
                    siteResponses = await findSiteRoleLiveResponses(getContainer, {
                        siteId: assignment.siteId,
                        targetRole: assignment.targetRole,
                    });
                } catch (__) {
                    siteResponses = prior ? [prior] : [];
                }
            }

            // Last two distinct submissions for delta (prefer newest pair)
            const latestTwo = siteResponses.slice(0, 2);
            const delta =
                latestTwo.length >= 2
                    ? compareSurveyResponses({
                          current: latestTwo[0],
                          previous: latestTwo[1],
                          questions,
                      })
                    : latestTwo.length === 1
                      ? compareSurveyResponses({
                            current: latestTwo[0],
                            previous: null,
                            questions,
                        })
                      : null;

            let attachmentDocs = [];
            try {
                attachmentDocs = await loadAttachmentDocs(
                    getContainer,
                    assignment.attachmentIds || []
                );
            } catch (_) {
                attachmentDocs = [];
            }

            return {
                jsonBody: buildPublicPayload({
                    assignment,
                    definition,
                    siteName,
                    prior,
                    siteRoleResponses: siteResponses,
                    questions,
                    delta,
                    siteDoc,
                    coordinatorStaff,
                    piStaff,
                    attachments: attachmentDocs,
                }),
                headers: corsHeaders(),
            };
        } catch (error) {
            return handleError(context, error, 'public/site-survey GET');
        }
    };

    const handlePublicSiteSurveyPost = async (request, context) => {
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

            const providedPw = readProvidedPassword(request, body);
            if (action === 'unlock') {
                if (!rateLimit(`unlock:${ip}:${assignment.id}`, 12, 60_000)) {
                    return {
                        status: 429,
                        jsonBody: { error: 'Too many password attempts. Wait a minute and try again.' },
                        headers: corsHeaders(),
                    };
                }
                if (!passwordOk(assignment, providedPw)) {
                    return {
                        status: 401,
                        jsonBody: {
                            error: 'invalid_password',
                            requiresPassword: true,
                            message: 'Incorrect password. Use the password from your invitation email.',
                        },
                        headers: corsHeaders(),
                    };
                }
                return {
                    status: 200,
                    jsonBody: { ok: true, unlocked: true },
                    headers: corsHeaders(),
                };
            }

            const gated = passwordGateFailure(assignment, providedPw);
            if (gated) return gated;

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

            // Light server-side required check against merged questions (gen feas + study)
            let definition = null;
            try {
                const defRead = await getContainer(DEFINITIONS)
                    .item(assignment.surveyId, assignment.surveyId)
                    .read();
                definition = defRead.resource;
            } catch (_) {}
            const questions = definition
                ? await resolvePublicSurveyQuestions(getContainer, definition, {
                      generalFeasibilityVariant: assignment.generalFeasibilityVariant || 'long',
                  }).catch((err) => {
                      console.warn('public submit question resolve failed', err?.message || err);
                      return [];
                  })
                : [];
            if (questions.length) {
                const byId = new Map(answers.map((a) => [String(a.questionId), a]));
                const missing = [];
                const unconfirmed = [];
                for (const q of questions) {
                    // Default required; branching rows marked skipped when not qualified
                    if (q.required === false) continue;
                    const a = byId.get(String(q.id));
                    if (a?.skipped) continue;
                    const val = a?.value ?? a?.answer ?? a?.answerText;
                    const empty = val == null
                        || (Array.isArray(val) ? val.length === 0 : String(val).trim() === '');
                    if (empty) {
                        missing.push(q.label || q.id);
                        continue;
                    }
                    if (a && a.confirmed === false) {
                        unconfirmed.push(q.label || q.id);
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
                if (unconfirmed.length) {
                    return {
                        status: 400,
                        jsonBody: {
                            error: 'Please confirm each answer is correct',
                            unconfirmed,
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
    };

    // ---------- Public: load / draft / submit by token ----------
    app.http('publicSiteSurvey', {
        methods: ['GET', 'POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'public/site-survey',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            if (request.method === 'GET') {
                return handlePublicSiteSurveyGet(request, context);
            }
            if (request.method === 'POST') {
                return handlePublicSiteSurveyPost(request, context);
            }
            return { status: 405, jsonBody: { error: 'Method not allowed' }, headers: corsHeaders() };
        },
    });

    // ---------- Public: download invite attachment by token ----------
    app.http('publicSiteSurveyAttachment', {
        methods: ['GET', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'public/site-survey/attachment',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                const raw = readQueryParam(request, 't') || readQueryParam(request, 'token');
                const attachmentId = readQueryParam(request, 'id');
                if (!raw || !attachmentId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'token and attachment id are required' },
                        headers: corsHeaders(),
                    };
                }
                const assignment = await findAssignmentByToken(getContainer, raw);
                const bad = assertTokenUsable(assignment);
                if (bad) {
                    return { status: bad.status, jsonBody: { error: bad.error }, headers: corsHeaders() };
                }
                const gated = passwordGateFailure(assignment, readProvidedPassword(request, null));
                if (gated) return gated;
                const allowed = new Set(assignment.attachmentIds || []);
                if (!allowed.has(String(attachmentId))) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Attachment not found for this invite' },
                        headers: corsHeaders(),
                    };
                }
                const docs = await loadAttachmentDocs(getContainer, [attachmentId]);
                const doc = docs[0];
                if (!doc?.contentBase64) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Attachment content missing' },
                        headers: corsHeaders(),
                    };
                }
                const bytes = Buffer.from(String(doc.contentBase64).replace(/\s+/g, ''), 'base64');
                return {
                    status: 200,
                    body: bytes,
                    headers: {
                        ...corsHeaders(),
                        'Content-Type': doc.contentType || 'application/octet-stream',
                        'Content-Disposition': `attachment; filename="${String(doc.fileName || 'file').replace(/"/g, '')}"`,
                        'Cache-Control': 'no-store',
                    },
                };
            } catch (error) {
                return handleError(context, error, 'public/site-survey/attachment');
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
                const expiresInDays = clampExpiresInDays(body?.expiresInDays ?? DEFAULT_TTL_DAYS);
                const baseUrl = String(body?.baseUrl || '').replace(/\/$/, '');
                const sendEmail = body?.sendEmail !== false;
                const operator =
                    body?.operator ||
                    readHeader(request, 'X-Artemis-Operator') ||
                    'unknown';
                let generalFeasibilityVariant = normalizeGeneralFeasibilityVariant(
                    body?.generalFeasibilityVariant ?? 'long'
                );
                if (isGeneralFeasibilitySurveyId(surveyId)) {
                    generalFeasibilityVariant = 'none';
                }

                const ccEmails = parseCcList(body?.cc || body?.ccEmails || '');
                const customSubject = String(body?.subject || body?.emailSubject || '')
                    .trim()
                    .slice(0, 200);
                const invitePassword = String(body?.password || body?.emailPassword || '')
                    .trim()
                    .slice(0, 80);
                const invitePasswordHash = hashSurveyPassword(invitePassword);
                const inviteDueDate = String(body?.dueDate || body?.emailDueDate || '')
                    .trim()
                    .slice(0, 80);

                let attachmentMeta = [];
                let emailFiles = [];
                try {
                    const incoming = normalizeIncomingAttachments(body?.attachments || []);
                    if (incoming.length) {
                        attachmentMeta = await persistAttachments(
                            getContainer,
                            getCosmosClient,
                            generateId,
                            incoming,
                            { surveyId, operator, batchId: generateId() }
                        );
                        const docs = await loadAttachmentDocs(
                            getContainer,
                            attachmentMeta.map((a) => a.id)
                        );
                        emailFiles = emailAttachmentPayload(docs);
                    }
                } catch (attErr) {
                    return {
                        status: 400,
                        jsonBody: { error: attErr.message || 'Invalid attachments' },
                        headers: corsHeaders(),
                    };
                }

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

                const studyCode = String(
                    body?.studyCode || body?.protocolNumber || definition.studyCode || ''
                ).trim();
                const studyTitle = String(
                    body?.studyTitle || definition.studyTitle || definition.title || ''
                ).trim();

                const asgC = getContainer(ASSIGNMENTS);
                const results = [];
                const now = new Date().toISOString();
                const attachmentIds = attachmentMeta.map((a) => a.id);
                const attachmentNames = attachmentMeta.map((a) => a.fileName);

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
                            generalFeasibilityVariant,
                            attachmentIds: attachmentIds.length ? attachmentIds : undefined,
                            attachments: attachmentMeta.length ? attachmentMeta : undefined,
                            emailCc: ccEmails.length ? ccEmails : undefined,
                            emailSubject: customSubject || undefined,
                            emailDueDate: inviteDueDate || undefined,
                            studyCode: studyCode || undefined,
                            studyTitle: studyTitle || undefined,
                            // Same hash on every assignment in this send — one password unlocks all links.
                            passwordHash: invitePasswordHash || undefined,
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
                                roleSubjectLabel: roleSubjectLabel(targetRole),
                                inviteUrl,
                                expiresAt: assignment.expiresAt,
                                attachmentNames,
                                studyCode,
                                studyTitle,
                                password: invitePassword,
                                dueDate: inviteDueDate,
                                subjectOverride: customSubject,
                            });
                            emailResult = await deliverSurveyEmail({
                                to: email,
                                cc: ccEmails,
                                subject: copy.subject,
                                text: copy.text,
                                html: copy.html,
                                attachments: emailFiles,
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
                        cc: ccEmails,
                        subject: customSubject || null,
                        passwordRequired: Boolean(invitePasswordHash),
                        attachments: attachmentMeta,
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
                    assignment.expiresAt = defaultExpiresAt(clampExpiresInDays(body.expiresInDays));
                } else if (!assignment.expiresAt || isExpired(assignment.expiresAt)) {
                    assignment.expiresAt = defaultExpiresAt(DEFAULT_TTL_DAYS);
                }

                const { inviteUrl } = attachInviteToken(assignment, {
                    expiresInDays: clampExpiresInDays(body.expiresInDays || DEFAULT_TTL_DAYS),
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
                    const resendCc = parseCcList(body?.cc || assignment.emailCc || '');
                    const resendSubject = String(
                        body?.subject || assignment.emailSubject || ''
                    )
                        .trim()
                        .slice(0, 200);
                    let resendFiles = [];
                    let attachmentNames = [];
                    try {
                        const docs = await loadAttachmentDocs(
                            getContainer,
                            assignment.attachmentIds || []
                        );
                        resendFiles = emailAttachmentPayload(docs);
                        attachmentNames = docs.map((d) => d.fileName).filter(Boolean);
                    } catch (_) {}
                    const copy = inviteEmailCopy({
                        siteName,
                        roleLabel: roleLabel(assignment.targetRole),
                        roleSubjectLabel: roleSubjectLabel(assignment.targetRole),
                        inviteUrl,
                        expiresAt: assignment.expiresAt,
                        attachmentNames,
                        studyCode: assignment.studyCode,
                        studyTitle: assignment.studyTitle,
                        password: String(body?.password || body?.emailPassword || '').trim(),
                        dueDate: String(body?.dueDate || assignment.emailDueDate || '').trim(),
                        subjectOverride: resendSubject,
                    });
                    emailResult = await deliverSurveyEmail({
                        to: email,
                        cc: resendCc,
                        subject: copy.subject,
                        text: copy.text,
                        html: copy.html,
                        attachments: resendFiles,
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
