/**
 * Shared site-survey response write path (submit + resubmit merge).
 * Used by public token API and legacy POST /site-survey-responses.
 */
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
        if (a.skipped) return;
        const v = a.value;
        if (v == null || String(v).trim() === '') return;
        map[String(qid)] = v;
    });
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
                return { ...a, value: prev.value, _keptFromPrior: true };
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
        if (validateSurveyResponsesSchema) validateSurveyResponsesSchema(updated);
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
    if (validateSurveyResponsesSchema) validateSurveyResponsesSchema(created);
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
    mergeAnswers,
    scoreAnswers,
    computeScore,
    readPassThresholds,
    findLatestLiveResponse,
    writeSurveyResponse,
};
