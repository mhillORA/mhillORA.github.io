/**
 * Feasibility survey rescoring (ARTEMIS only).
 *
 * HARD SAFETY CONTRACT — this module may ONLY mutate these fields on a
 * site-survey-responses document:
 *   - score
 *   - siteDisposition   (derived from score.outcome only)
 *   - scoreBeforeRescore (snapshot of prior score; audit only)
 *   - rescoredAt / rescoredBy
 *   - updatedAt
 *
 * It MUST NOT change: answers, surveyId, siteId, targetRole, assignmentId,
 * submittedAt, definition documents, assignments, sites, schedules, patients.
 */
const {
    scoreAnswers,
    applyEarlyExitDisposition,
} = require('./lib/survey-response-service');

const RESPONSES = 'site-survey-responses';
const DEFINITIONS = 'site-survey-definitions';

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

function dispositionFromScore(score) {
    if (!score || typeof score !== 'object') return null;
    if (score.outcome === 'not_interested' || score.outcome === 'fail') return score.outcome;
    return null;
}

/**
 * Build the next response doc with score fields only.
 * Answers and identity fields are copied verbatim from `existing`.
 */
function buildRescoredDoc(existing, newScore, operator, now) {
    const priorScore = existing.score && typeof existing.score === 'object'
        ? existing.score
        : null;
    const nextDisposition = dispositionFromScore(newScore);

    // Start from a shallow clone, then FORCE protected fields back from existing.
    const next = {
        ...existing,
        score: newScore,
        siteDisposition: nextDisposition,
        scoreBeforeRescore: priorScore,
        rescoredAt: now,
        rescoredBy: operator || 'unknown',
        updatedAt: now,
    };

    // Absolute guarantees — never rewrite submission payload / keys
    next.id = existing.id;
    next.answers = existing.answers;
    next.surveyId = existing.surveyId;
    next.siteId = existing.siteId;
    next.targetRole = existing.targetRole;
    next.assignmentId = existing.assignmentId;
    next.submittedAt = existing.submittedAt;
    next.createdAt = existing.createdAt;
    if (Object.prototype.hasOwnProperty.call(existing, '_archived')) {
        next._archived = existing._archived;
    }

    return next;
}

async function loadDefinition(getContainer, surveyId) {
    const defC = getContainer(DEFINITIONS);
    try {
        const { resource } = await defC.item(surveyId, surveyId).read();
        return resource || null;
    } catch (_) {
        return null;
    }
}

function computeScoreFromDef(def, answers) {
    const scored = scoreAnswers(def, answers);
    return applyEarlyExitDisposition(def, answers, scored);
}

async function rescoreOneResponse(getContainer, responseId, operator) {
    const rspC = getContainer(RESPONSES);
    let existing;
    try {
        const read = await rspC.item(responseId, responseId).read();
        existing = read.resource;
    } catch (_) {
        existing = null;
    }
    if (!existing) {
        return { ok: false, error: 'Response not found', status: 404 };
    }
    if (existing._archived === true) {
        return { ok: false, error: 'Cannot rescore an archived response copy', status: 400 };
    }
    const surveyId = String(existing.surveyId || '').trim();
    if (!surveyId) {
        return { ok: false, error: 'Response has no surveyId', status: 400 };
    }
    const def = await loadDefinition(getContainer, surveyId);
    if (!def) {
        return { ok: false, error: 'Survey definition not found', status: 404 };
    }

    const now = new Date().toISOString();
    const newScore = computeScoreFromDef(def, existing.answers);
    const next = buildRescoredDoc(existing, newScore, operator, now);
    await rspC.items.upsert(next);

    return {
        ok: true,
        responseId: existing.id,
        surveyId,
        siteId: existing.siteId,
        priorOutcome: priorOutcome(existing.score),
        outcome: newScore?.outcome || 'unscored',
        pct: typeof newScore?.pct === 'number' ? newScore.pct : null,
        hasScoring: !!(newScore && newScore.hasScoring !== false && newScore !== null),
        score: newScore,
    };
}

function priorOutcome(score) {
    if (!score || typeof score !== 'object') return 'unscored';
    if (score.outcome) return String(score.outcome);
    if (typeof score.pct === 'number') return 'scored';
    return 'unscored';
}

function registerSurveyRescoreRoutes(app, deps) {
    const { getContainer, handleError } = deps;

    app.http('siteSurveyResponseRescore', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'site-survey-responses/{id}/rescore',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                const id = String(request.params?.id || '').trim();
                if (!id) {
                    return {
                        status: 400,
                        jsonBody: { error: 'response id required' },
                        headers: corsHeaders(),
                    };
                }
                const body = await request.json().catch(() => ({}));
                const operator =
                    body?.operator ||
                    readHeader(request, 'X-Artemis-Operator') ||
                    'unknown';
                const result = await rescoreOneResponse(getContainer, id, operator);
                if (!result.ok) {
                    return {
                        status: result.status || 400,
                        jsonBody: { error: result.error },
                        headers: corsHeaders(),
                    };
                }
                return {
                    status: 200,
                    jsonBody: result,
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'site-survey-responses/rescore');
            }
        },
    });

    app.http('siteSurveyDefinitionRescoreAll', {
        methods: ['POST', 'OPTIONS'],
        authLevel: 'anonymous',
        route: 'site-survey-definitions/{id}/rescore-responses',
        handler: async (request, context) => {
            if (request.method === 'OPTIONS') {
                return { status: 204, headers: corsHeaders() };
            }
            try {
                const surveyId = String(request.params?.id || '').trim();
                if (!surveyId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'survey definition id required' },
                        headers: corsHeaders(),
                    };
                }
                const body = await request.json().catch(() => ({}));
                const dryRun = body?.dryRun === true || body?.mode === 'dryRun';
                const operator =
                    body?.operator ||
                    readHeader(request, 'X-Artemis-Operator') ||
                    'unknown';

                const def = await loadDefinition(getContainer, surveyId);
                if (!def) {
                    return {
                        status: 404,
                        jsonBody: { error: 'Survey definition not found' },
                        headers: corsHeaders(),
                    };
                }

                const rspC = getContainer(RESPONSES);
                const { resources } = await rspC.items
                    .query(
                        {
                            query:
                                'SELECT c.id, c.siteId, c.surveyId, c._archived FROM c WHERE c.surveyId = @sid AND (NOT IS_DEFINED(c._archived) OR c._archived != true)',
                            parameters: [{ name: '@sid', value: surveyId }],
                        },
                        { enableCrossPartitionQuery: true }
                    )
                    .fetchAll();

                const ids = (resources || []).map((r) => r.id).filter(Boolean);
                if (dryRun) {
                    return {
                        status: 200,
                        jsonBody: {
                            ok: true,
                            dryRun: true,
                            surveyId,
                            wouldRescore: ids.length,
                            responseIds: ids,
                        },
                        headers: corsHeaders(),
                    };
                }

                const results = [];
                let updated = 0;
                let failed = 0;
                for (const id of ids) {
                    const r = await rescoreOneResponse(getContainer, id, operator);
                    if (r.ok) {
                        updated += 1;
                        results.push({
                            responseId: r.responseId,
                            siteId: r.siteId,
                            priorOutcome: r.priorOutcome,
                            outcome: r.outcome,
                            pct: r.pct,
                        });
                    } else {
                        failed += 1;
                        results.push({ responseId: id, error: r.error });
                    }
                }

                return {
                    status: 200,
                    jsonBody: {
                        ok: true,
                        dryRun: false,
                        surveyId,
                        scanned: ids.length,
                        updated,
                        failed,
                        results,
                    },
                    headers: corsHeaders(),
                };
            } catch (error) {
                return handleError(context, error, 'site-survey-definitions/rescore-responses');
            }
        },
    });
}

module.exports = {
    registerSurveyRescoreRoutes,
    buildRescoredDoc,
    rescoreOneResponse,
};
