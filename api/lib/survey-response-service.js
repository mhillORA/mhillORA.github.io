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

async function computeScore(getContainer, surveyId, answers) {
    try {
        const defC = getContainer('site-survey-definitions');
        const defRead = await defC.item(surveyId, surveyId).read();
        const def = defRead.resource;
        if (!def || !Array.isArray(def.questions)) return null;
        const scorableQs = def.questions.filter(
            (q) => typeof q.scoringWeight === 'number' && q.scoringWeight > 0 && q.scoringOptions
        );
        if (!scorableQs.length) return null;
        let totalWeight = 0;
        let earned = 0;
        scorableQs.forEach((q) => {
            const ans = (Array.isArray(answers) ? answers : []).find(
                (a) => a.questionId === q.id || a.questionId === String(q.id)
            );
            if (!ans || ans.skipped) return;
            totalWeight += q.scoringWeight;
            const opts = Array.isArray(q.scoringOptions) ? q.scoringOptions : [];
            const match = opts.find(
                (o) => String(o.value ?? o.label ?? '') === String(ans.value ?? '').trim()
            );
            if (match && typeof match.points === 'number') earned += match.points;
        });
        if (totalWeight === 0) return null;
        return { earned, totalWeight, pct: Math.round((earned / totalWeight) * 100) };
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
    computeScore,
    findLatestLiveResponse,
    writeSurveyResponse,
};
