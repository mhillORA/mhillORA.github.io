/**
 * Shared site-survey response write path (submit + resubmit merge).
 * Used by public token API and legacy POST /site-survey-responses.
 */
const {
    normalizeQuestionLabel,
    readAnswerValue,
    answerIsFilled,
    compareSurveyResponses,
    mergeGeneralFeasibilityQuestions,
    GENERAL_FEASIBILITY_SURVEY_ID,
    GENERAL_FEASIBILITY_SHORT_SURVEY_ID,
    GENERAL_FEASIBILITY_SHORT_QUESTION_IDS,
    normalizeGeneralFeasibilityVariant,
    isGeneralFeasibilitySurveyId,
} = require('./survey-compare');

function sortByIsoDesc(rows, keys) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const fields = Array.isArray(keys) ? keys : [keys];
    list.sort((a, b) => {
        const av = fields.map((k) => a?.[k]).find(Boolean) || '';
        const bv = fields.map((k) => b?.[k]).find(Boolean) || '';
        return String(bv).localeCompare(String(av));
    });
    return list;
}

function normalizeRole(role) {
    return String(role || '').trim().toLowerCase();
}

function answersToPrefillMap(answers) {
    const map = {};
    (Array.isArray(answers) ? answers : []).forEach((a) => {
        if (!a) return;
        const qid = a.questionId ?? a.id ?? a.qid;
        if (!qid) return;
        const v = readAnswerValue(a);
        if (!v) return;
        map[String(qid)] = v;
    });
    return map;
}

/**
 * Prefill current survey questions from any prior site responses.
 * Match order per question: same questionId → libraryQuestionId → normalized label text.
 * Prefer same-role responses, but fall back to any role (e.g. gen feas stored as PI).
 * Newest responses win (caller should pass newest-first).
 */
function buildPrefillMapForQuestions(questions, responseList, { preferRole } = {}) {
    const map = {};
    const qs = Array.isArray(questions) ? questions : [];
    const role = preferRole ? normalizeRole(preferRole) : '';
    const responses = Array.isArray(responseList) ? responseList.slice() : [];
    if (role) {
        responses.sort((a, b) => {
            const ar = normalizeRole(a?.targetRole) === role ? 0 : 1;
            const br = normalizeRole(b?.targetRole) === role ? 0 : 1;
            if (ar !== br) return ar - br;
            return 0;
        });
    }

    for (const q of qs) {
        const qid = String(q?.id || '');
        if (!qid || map[qid] != null) continue;
        const libId = q?.libraryQuestionId ? String(q.libraryQuestionId) : '';
        const norm = normalizeQuestionLabel(q?.label || q?.title);

        for (const resp of responses) {
            const answers = Array.isArray(resp?.answers) ? resp.answers : [];
            let found = answers.find(
                (a) => answerIsFilled(a) && String(a.questionId ?? a.id ?? '') === qid
            );
            if (!found && libId) {
                found = answers.find(
                    (a) =>
                        answerIsFilled(a) &&
                        (String(a.libraryQuestionId || '') === libId ||
                            String(a.questionId ?? '') === libId)
                );
            }
            if (!found && norm) {
                found = answers.find(
                    (a) => answerIsFilled(a) && normalizeQuestionLabel(a.label) === norm
                );
            }
            if (found) {
                map[qid] = readAnswerValue(found);
                break;
            }
        }
    }
    return map;
}

function mergeAnswers(incoming, priorAnswers) {
    const oldAnswerMap = new Map(
        (priorAnswers || []).map((a) => [String(a.questionId ?? a.id ?? ''), a])
    );
    return (Array.isArray(incoming) ? incoming : []).map((a) => {
        const hasValue = !a.skipped && String(a.value ?? '').trim() !== '';
        if (!hasValue) {
            const prev = oldAnswerMap.get(String(a.questionId ?? ''));
            if (prev && !prev.skipped && String(prev.value ?? '').trim() !== '') {
                return {
                    ...a,
                    value: prev.value,
                    confirmed: a.confirmed ?? prev.confirmed,
                    _keptFromPrior: true,
                };
            }
        }
        return a;
    });
}

function normalizeAnswerValue(value) {
    return String(value ?? '').trim();
}

function findAnswerForQuestionId(answers, questionId) {
    const qid = String(questionId ?? '');
    return (Array.isArray(answers) ? answers : []).find(
        (a) => a && (a.questionId === questionId || String(a.questionId) === qid)
    );
}

function optionMatches(opt, answerValue) {
    const av = normalizeAnswerValue(answerValue);
    if (!av) return false;
    const ov = normalizeAnswerValue(opt?.value ?? opt?.label ?? '');
    return ov !== '' && ov === av;
}

function readPassThresholds(def) {
    const scoring = def?.scoring && typeof def.scoring === 'object' ? def.scoring : {};
    const passRaw = def?.passThreshold ?? scoring.passThreshold ?? 70;
    const borderRaw = def?.borderlineThreshold ?? scoring.borderlineThreshold ?? 50;
    let passThreshold = Number(passRaw);
    let borderlineThreshold = Number(borderRaw);
    if (!Number.isFinite(passThreshold)) passThreshold = 70;
    if (!Number.isFinite(borderlineThreshold)) borderlineThreshold = 50;
    passThreshold = Math.max(0, Math.min(100, passThreshold));
    borderlineThreshold = Math.max(0, Math.min(passThreshold, borderlineThreshold));
    return { passThreshold, borderlineThreshold };
}

/**
 * Pure scoring against a survey definition.
 * @returns {null|object} null when the definition has no scoring or knockout config
 */
function scoreAnswers(def, answers) {
    if (!def || !Array.isArray(def.questions) || !def.questions.length) return null;

    const { passThreshold, borderlineThreshold } = readPassThresholds(def);
    const knockouts = [];
    const byCategory = {};
    let earned = 0;
    let totalWeight = 0;
    let scoredQuestionCount = 0;
    let configuredScorable = 0;
    let configuredKnockouts = 0;

    def.questions.forEach((q) => {
        if (!q) return;
        const opts = Array.isArray(q.scoringOptions) ? q.scoringOptions : [];
        const weight = typeof q.scoringWeight === 'number' && q.scoringWeight > 0 ? q.scoringWeight : 0;
        if (weight > 0 && opts.length) configuredScorable += 1;

        const failFromOpts = opts.filter((o) => o && (o.knockout === true || o.fail === true));
        const explicitFails = Array.isArray(q.knockoutFailValues)
            ? q.knockoutFailValues.map(normalizeAnswerValue).filter(Boolean)
            : [];
        const isKnockoutConfigured =
            q.knockout === true || failFromOpts.length > 0 || explicitFails.length > 0;
        if (isKnockoutConfigured) configuredKnockouts += 1;

        const ans = findAnswerForQuestionId(answers, q.id);
        const ansVal = ans && !ans.skipped ? normalizeAnswerValue(ans.value) : '';
        const match = ansVal ? opts.find((o) => optionMatches(o, ansVal)) : null;

        if (isKnockoutConfigured) {
            const failSet = new Set([
                ...explicitFails,
                ...failFromOpts.map((o) => normalizeAnswerValue(o.value ?? o.label)),
            ]);
            if (ansVal && failSet.has(ansVal)) {
                knockouts.push({
                    questionId: q.id,
                    label: q.label || q.id,
                    answer: ansVal,
                    reason: 'Failed knockout criterion',
                });
            } else if (q.knockout === true && q.knockoutOnBlank === true && !ansVal) {
                knockouts.push({
                    questionId: q.id,
                    label: q.label || q.id,
                    answer: '(blank)',
                    reason: 'Required knockout left blank',
                });
            }
        }

        if (!(weight > 0 && opts.length)) return;
        if (!ansVal) return;

        scoredQuestionCount += 1;
        totalWeight += weight;
        const pts = match && typeof match.points === 'number' ? match.points : 0;
        earned += pts;

        const cat = String(q.category || 'General').trim() || 'General';
        if (!byCategory[cat]) byCategory[cat] = { earned: 0, totalWeight: 0, pct: 0 };
        byCategory[cat].earned += pts;
        byCategory[cat].totalWeight += weight;
    });

    if (configuredScorable === 0 && configuredKnockouts === 0) return null;

    Object.keys(byCategory).forEach((cat) => {
        const row = byCategory[cat];
        row.pct = row.totalWeight > 0 ? Math.round((row.earned / row.totalWeight) * 100) : 0;
    });

    const pct = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;
    let outcome = 'unscored';
    if (knockouts.length) {
        outcome = 'fail';
    } else if (totalWeight > 0) {
        if (pct >= passThreshold) outcome = 'pass';
        else if (pct >= borderlineThreshold) outcome = 'borderline';
        else outcome = 'fail';
    } else if (configuredKnockouts > 0) {
        outcome = 'pass';
    }

    return {
        earned,
        totalWeight,
        pct,
        outcome,
        passThreshold,
        borderlineThreshold,
        knockouts,
        byCategory,
        scoredQuestionCount,
        hasScoring: configuredScorable > 0 || configuredKnockouts > 0,
        scoredAt: new Date().toISOString(),
    };
}

async function computeScore(getContainer, surveyId, answers) {
    try {
        const defC = getContainer('site-survey-definitions');
        const defRead = await defC.item(surveyId, surveyId).read();
        const def = defRead.resource;
        return scoreAnswers(def, answers);
    } catch (_) {
        return null;
    }
}

async function findLatestLiveResponse(getContainer, { siteId, surveyId, targetRole }) {
    const rspC = getContainer('site-survey-responses');
    const role = normalizeRole(targetRole);
    const { resources } = await rspC.items
        .query(
            {
                query:
                    'SELECT * FROM c WHERE c.siteId = @siteId AND c.surveyId = @surveyId AND LOWER(c.targetRole) = @targetRole AND (NOT IS_DEFINED(c._archived) OR c._archived != true)',
                parameters: [
                    { name: '@siteId', value: String(siteId) },
                    { name: '@surveyId', value: String(surveyId) },
                    { name: '@targetRole', value: role },
                ],
            },
            { enableCrossPartitionQuery: true }
        )
        .fetchAll();
    if (!resources || !resources.length) return null;
    return sortByIsoDesc(resources, ['submittedAt', 'updatedAt', 'createdAt'])[0];
}

/** All live responses for a site+role (any survey) — newest first. Used for cross-survey prefill. */
async function findSiteRoleLiveResponses(getContainer, { siteId, targetRole, limit = 50 }) {
    const rspC = getContainer('site-survey-responses');
    const role = normalizeRole(targetRole);
    const { resources } = await rspC.items
        .query(
            {
                query:
                    'SELECT * FROM c WHERE c.siteId = @siteId AND LOWER(c.targetRole) = @targetRole AND (NOT IS_DEFINED(c._archived) OR c._archived != true)',
                parameters: [
                    { name: '@siteId', value: String(siteId) },
                    { name: '@targetRole', value: role },
                ],
            },
            { enableCrossPartitionQuery: true }
        )
        .fetchAll();
    const sorted = sortByIsoDesc(resources || [], ['submittedAt', 'updatedAt', 'createdAt']);
    const cap = Math.max(1, Math.min(200, Number(limit) || 50));
    return sorted.slice(0, cap);
}

/**
 * All live responses for one or more site ids (any role/survey) — newest first.
 * Used when gen-feas answers were stored as PI but coordinator opens a link, or legacy site ids.
 */
async function findSiteLiveResponses(getContainer, { siteIds, limit = 80 }) {
    const ids = [...new Set((Array.isArray(siteIds) ? siteIds : [siteIds]).map(String).filter(Boolean))];
    if (!ids.length) return [];
    const rspC = getContainer('site-survey-responses');
    const clauses = ids.map((_, i) => `c.siteId = @s${i}`);
    const parameters = ids.map((id, i) => ({ name: `@s${i}`, value: id }));
    const { resources } = await rspC.items
        .query(
            {
                query: `SELECT * FROM c WHERE (${clauses.join(' OR ')}) AND (NOT IS_DEFINED(c._archived) OR c._archived != true)`,
                parameters,
            },
            { enableCrossPartitionQuery: true }
        )
        .fetchAll();
    const sorted = sortByIsoDesc(resources || [], ['submittedAt', 'updatedAt', 'createdAt']);
    const cap = Math.max(1, Math.min(200, Number(limit) || 80));
    return sorted.slice(0, cap);
}

async function resolveRelatedSiteIds(getContainer, siteId) {
    const ids = new Set([String(siteId)]);
    try {
        const read = await getContainer('sites').item(String(siteId), String(siteId)).read();
        const site = read.resource;
        if (Array.isArray(site?.legacySiteIds)) {
            site.legacySiteIds.forEach((id) => {
                if (id) ids.add(String(id));
            });
        }
        if (site?.promotedFromLegacySiteId) ids.add(String(site.promotedFromLegacySiteId));
    } catch (_) {
        /* ignore */
    }
    return [...ids];
}

async function loadGeneralFeasibilityDefinition(getContainer, variant = 'long') {
    const v = normalizeGeneralFeasibilityVariant(variant);
    if (v === 'none') return null;
    const primaryId = v === 'short' ? GENERAL_FEASIBILITY_SHORT_SURVEY_ID : GENERAL_FEASIBILITY_SURVEY_ID;
    try {
        const read = await getContainer('site-survey-definitions').item(primaryId, primaryId).read();
        if (read.resource) return read.resource;
    } catch (_) {
        /* fall through */
    }
    // Short missing: derive from Long using shared question ids
    if (v === 'short') {
        try {
            const read = await getContainer('site-survey-definitions')
                .item(GENERAL_FEASIBILITY_SURVEY_ID, GENERAL_FEASIBILITY_SURVEY_ID)
                .read();
            const longDef = read.resource;
            if (!longDef) return null;
            const allow = new Set(GENERAL_FEASIBILITY_SHORT_QUESTION_IDS);
            return {
                ...longDef,
                id: GENERAL_FEASIBILITY_SHORT_SURVEY_ID,
                title: 'General Feasibility (Short)',
                questions: (longDef.questions || []).filter((q) => allow.has(String(q?.id || ''))),
            };
        } catch (_) {
            return null;
        }
    }
    return null;
}

/** Definition questions with General Feasibility always first (deduped). Required defaults to true. */
async function resolvePublicSurveyQuestions(getContainer, definition, opts = {}) {
    const studyQs = Array.isArray(definition?.questions) ? definition.questions : [];
    let variant = normalizeGeneralFeasibilityVariant(
        opts.generalFeasibilityVariant ?? definition?.generalFeasibilityVariant ?? 'long'
    );
    // Sending GF itself — do not double-prepend
    if (isGeneralFeasibilitySurveyId(definition?.id)) {
        variant = 'none';
    }
    let genQs = [];
    if (variant !== 'none') {
        try {
            const genDef = await loadGeneralFeasibilityDefinition(getContainer, variant);
            genQs = Array.isArray(genDef?.questions) ? genDef.questions : [];
        } catch (err) {
            // Never blank the whole survey if GF template is missing/broken
            console.warn('resolvePublicSurveyQuestions GF load failed', err?.message || err);
            genQs = [];
        }
    }
    const merged = mergeGeneralFeasibilityQuestions(studyQs, genQs, {
        studySurveyId: definition?.id,
    });
    return merged.map((q, idx) => ({
        ...q,
        id: q.id || `q_${idx}`,
        // Default required unless explicitly false. Branching still only enforced when visible.
        required: q.required !== false,
        fromGeneralFeasibility: !!q._fromGeneralFeasibility || !!q.fromGeneralFeasibility,
    }));
}

/**
 * Upsert a submitted (or draft) response bound to an assignment.
 * @returns {{ resource, resubmitted: boolean, created: boolean }}
 */
async function writeSurveyResponse(deps, { assignment, answers, email, displayName, isDraft = false }) {
    const { getContainer, generateId, validateSurveyResponsesSchema } = deps;
    const now = new Date().toISOString();
    const asgC = getContainer('site-survey-assignments');
    const rspC = getContainer('site-survey-responses');

    const body = {
        assignmentId: assignment.id,
        surveyId: assignment.surveyId,
        siteId: assignment.siteId,
        targetRole: assignment.targetRole,
        answers: Array.isArray(answers) ? answers : [],
        email: email || assignment.targetEmail || undefined,
        displayName: displayName || undefined,
        updatedAt: now,
    };

    if (isDraft) {
        const draftAssignment = {
            ...assignment,
            draftAnswers: body.answers,
            draftSavedAt: now,
            status: String(assignment.status || '').toLowerCase() === 'submitted' ? 'submitted' : 'opened',
            updatedAt: now,
        };
        const { resource } = await asgC.items.upsert(draftAssignment);
        return { resource, resubmitted: false, created: false, draft: true, assignment: resource };
    }

    body.submittedAt = now;
    const prior = await findLatestLiveResponse(getContainer, body);
    const score = await computeScore(getContainer, body.surveyId, body.answers);
    if (score !== null) body.score = score;

    if (prior) {
        try {
            await rspC.items.upsert({
                ...prior,
                id: `${prior.id}_archived_${now}`,
                _archived: true,
                _archivedAt: now,
                _replacedBy: prior.id,
            });
        } catch (_) {
            /* non-fatal */
        }

        const mergedAnswers = mergeAnswers(body.answers, prior.answers);
        const reScore = await computeScore(getContainer, body.surveyId, mergedAnswers);
        const updated = {
            ...prior,
            ...body,
            id: prior.id,
            answers: mergedAnswers,
            submittedAt: now,
            updatedAt: now,
            _resubmitCount: (prior._resubmitCount || 0) + 1,
            score: reScore !== null ? reScore : body.score ?? prior.score ?? null,
        };
        try {
            if (validateSurveyResponsesSchema) validateSurveyResponsesSchema(updated);
        } catch (schemaErr) {
            // Never block a site submit on schema nitpicks — keep answers on file
            console.warn('survey response schema warning (resubmit)', schemaErr?.message || schemaErr);
        }
        const { resource } = await rspC.items.upsert(updated);

        const asgSubmitted = {
            ...assignment,
            status: 'submitted',
            submittedAt: prior.submittedAt || now,
            updatedAt: now,
            draftAnswers: null,
            draftSavedAt: null,
            lastSubmittedAt: now,
        };
        delete asgSubmitted.draftAnswers;
        delete asgSubmitted.draftSavedAt;
        await asgC.items.upsert(asgSubmitted);

        return { resource: { ...resource, resubmitted: true }, resubmitted: true, created: false };
    }

    const created = { ...body, id: generateId(), createdAt: now };
    try {
        if (validateSurveyResponsesSchema) validateSurveyResponsesSchema(created);
    } catch (schemaErr) {
        console.warn('survey response schema warning (create)', schemaErr?.message || schemaErr);
    }
    const { resource } = await rspC.items.create(created);

    const asgFirst = {
        ...assignment,
        status: 'submitted',
        submittedAt: now,
        updatedAt: now,
        lastSubmittedAt: now,
    };
    delete asgFirst.draftAnswers;
    delete asgFirst.draftSavedAt;
    await asgC.items.upsert(asgFirst);

    return { resource, resubmitted: false, created: true };
}

module.exports = {
    sortByIsoDesc,
    normalizeRole,
    answersToPrefillMap,
    normalizeQuestionLabel,
    readAnswerValue,
    buildPrefillMapForQuestions,
    mergeAnswers,
    scoreAnswers,
    computeScore,
    readPassThresholds,
    findLatestLiveResponse,
    findSiteRoleLiveResponses,
    findSiteLiveResponses,
    resolveRelatedSiteIds,
    loadGeneralFeasibilityDefinition,
    resolvePublicSurveyQuestions,
    compareSurveyResponses,
    mergeGeneralFeasibilityQuestions,
    GENERAL_FEASIBILITY_SURVEY_ID,
    GENERAL_FEASIBILITY_SHORT_SURVEY_ID,
    normalizeGeneralFeasibilityVariant,
    isGeneralFeasibilitySurveyId,
    writeSurveyResponse,
};
