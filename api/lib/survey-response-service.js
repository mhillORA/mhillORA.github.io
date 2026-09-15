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
const {
    resolveGfBridgeLibraryId,
    resolveSourceLibraryId,
    reshapeBridgeAnswer,
} = require('./gf-question-bridges');

function resolveStoredAnswerLibraryId(a) {
    return resolveGfBridgeLibraryId(a);
}

function readBridgedAnswerValue(a) {
    const raw = readAnswerValue(a);
    if (!raw) return '';
    const shaped = reshapeBridgeAnswer(resolveGfBridgeLibraryId(a), raw, resolveSourceLibraryId(a));
    return shaped ? shaped.value : '';
}

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
                            String(a.questionId ?? '') === libId ||
                            resolveStoredAnswerLibraryId(a) === libId)
                );
            }
            if (!found && norm) {
                found = answers.find(
                    (a) => answerIsFilled(a) && normalizeQuestionLabel(a.label) === norm
                );
            }
            if (found) {
                const bridged = readBridgedAnswerValue(found);
                if (!bridged) continue;
                map[qid] = bridged;
                break;
            }
        }
    }
    return map;
}

/**
 * Prefill from live site + staff records (not prior survey answers).
 * Point-of-contact / research contact questions map to the site coordinator.
 */
function buildSiteRecordPrefill(questions, site, { coordinatorStaff = null, piStaff = null } = {}) {
    const map = {};
    if (!site || typeof site !== 'object') return map;
    const coord = coordinatorStaff && typeof coordinatorStaff === 'object' ? coordinatorStaff : {};
    const pi = piStaff && typeof piStaff === 'object' ? piStaff : {};
    const { siteAddressPrefill, siteNamePrefill, normalizeSiteFields } = require('./site-field-map');
    const normalized = normalizeSiteFields(site);

    const byLib = {
        'ql-coord-name': normalized.siteCoordinator || coord.name || '',
        'ql-coord-email': normalized.siteCoordinatorEmail || coord.email || '',
        'ql-coord-phone': site.siteCoordinatorPhone || coord.phone || coord.phoneNumber || '',
        'ql-coord-title': coord.title || 'Study Coordinator',
        'ql-primary-contact-role': coord.title || 'Study Coordinator',
        'ql-site-name': siteNamePrefill(site) || '',
        'ql-site-address': siteAddressPrefill(site) || '',
        'ql-site-phone': site.phone || site.sitePhone || site.mainPhone || '',
        'ql-pi-name': normalized.pi || pi.name || '',
        'ql-pi-email': normalized.piEmail || pi.email || '',
        'ql-pi-phone': site.piPhone || pi.phone || pi.phoneNumber || '',
        'ql-gf-00-name': '', // respondent — leave blank
    };

    const byQid = {
        'gf_15_research-contact': byLib['ql-coord-name'],
        'gf_16_poc-email': byLib['ql-coord-email'],
        'gsf_009_primary-research-point-of-contact-phone-number': byLib['ql-coord-phone'],
        'gf_17_poc-role': byLib['ql-primary-contact-role'],
        'gf_02_site-name': byLib['ql-site-name'],
        'gf_03_address': byLib['ql-site-address'],
        'gf_04_phone': byLib['ql-site-phone'],
        'gf_07_investigator-1': byLib['ql-pi-name'],
        'gf_09_inv-1-email': byLib['ql-pi-email'],
    };

    const labelHints = [
        {
            test: (n) => n.includes('primary research point of contact first') || n.includes('primary research contact first'),
            value: byLib['ql-coord-name'],
        },
        {
            test: (n) => n.includes('primary research contact email') || n.includes('primary research point of contact email'),
            value: byLib['ql-coord-email'],
        },
        {
            test: (n) => n.includes('primary research point of contact phone'),
            value: byLib['ql-coord-phone'],
        },
        {
            test: (n) => n.includes('primary research point of contact title') || n.includes('primary research point of contact role'),
            value: byLib['ql-primary-contact-role'],
        },
    ];

    for (const q of Array.isArray(questions) ? questions : []) {
        const qid = String(q?.id || '');
        if (!qid) continue;
        const libId = String(q?.libraryQuestionId || '');
        let val = '';
        if (libId && byLib[libId]) val = byLib[libId];
        if (!val && byQid[qid]) val = byQid[qid];
        if (!val) {
            const norm = normalizeQuestionLabel(q?.label || q?.title);
            for (const hint of labelHints) {
                if (hint.test(norm) && hint.value) {
                    val = hint.value;
                    break;
                }
            }
        }
        val = String(val || '').trim();
        if (val) map[qid] = val;
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

        const failFromOpts = opts.filter((o) => o && (o.knockout === true || o.fail === true)
            && o.notInterested !== true && String(o.disposition || '').toLowerCase() !== 'not_interested');
        const notInterestedFromOpts = opts.filter((o) => o && (
            o.notInterested === true
            || String(o.disposition || '').toLowerCase() === 'not_interested'
        ));
        const explicitFails = Array.isArray(q.knockoutFailValues)
            ? q.knockoutFailValues.map(normalizeAnswerValue).filter(Boolean)
            : [];
        const isKnockoutConfigured =
            q.knockout === true
            || failFromOpts.length > 0
            || notInterestedFromOpts.length > 0
            || explicitFails.length > 0;
        if (isKnockoutConfigured) configuredKnockouts += 1;

        const ans = findAnswerForQuestionId(answers, q.id);
        const ansVal = ans && !ans.skipped ? normalizeAnswerValue(ans.value) : '';
        const match = ansVal ? opts.find((o) => optionMatches(o, ansVal)) : null;

        if (isKnockoutConfigured) {
            const notInterestedSet = new Set(
                notInterestedFromOpts.map((o) => normalizeAnswerValue(o.value ?? o.label)).filter(Boolean)
            );
            const failSet = new Set([
                ...explicitFails,
                ...failFromOpts.map((o) => normalizeAnswerValue(o.value ?? o.label)),
            ]);
            if (ansVal && notInterestedSet.has(ansVal)) {
                knockouts.push({
                    questionId: q.id,
                    label: q.label || q.id,
                    answer: ansVal,
                    reason: 'Site not interested',
                    disposition: 'not_interested',
                });
            } else if (ansVal && failSet.has(ansVal)) {
                knockouts.push({
                    questionId: q.id,
                    label: q.label || q.id,
                    answer: ansVal,
                    reason: 'Failed knockout criterion',
                    disposition: 'fail',
                });
            } else if (q.knockout === true && q.knockoutOnBlank === true && !ansVal) {
                knockouts.push({
                    questionId: q.id,
                    label: q.label || q.id,
                    answer: '(blank)',
                    reason: 'Required knockout left blank',
                    disposition: 'fail',
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
    if (knockouts.some((k) => k && k.disposition === 'not_interested')) {
        outcome = 'not_interested';
    } else if (knockouts.length) {
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

/** True when an answer matches endSurveyIf on that question. */
function answerTriggersEndSurvey(q, answers) {
    const endIf = q?.logic?.endSurveyIf;
    if (!endIf || typeof endIf !== 'object') return false;
    const ans = findAnswerForQuestionId(answers, q.id);
    if (!ans || ans.skipped) return false;
    const ansVal = normalizeAnswerValue(ans.value);
    if (!ansVal) return false;
    const selected = String(ans.value || '')
        .split(',')
        .map((s) => normalizeAnswerValue(s))
        .filter(Boolean);
    const tokens = selected.length ? selected : [ansVal];
    const hit = (want) => {
        const w = normalizeAnswerValue(want);
        return w && tokens.some((t) => t === w);
    };
    let matched = false;
    if (endIf.includes != null && endIf.includes !== '' && hit(endIf.includes)) matched = true;
    if (endIf.equals != null && endIf.equals !== '' && hit(endIf.equals)) matched = true;
    if (Array.isArray(endIf.includesAny) && endIf.includesAny.some(hit)) matched = true;
    if (!matched) return false;
    const requireId = String(endIf.requireFilledQuestionId || '').trim();
    if (requireId) {
        const why = findAnswerForQuestionId(answers, requireId);
        if (!why || why.skipped || !normalizeAnswerValue(why.value)) return false;
    }
    return true;
}

/**
 * When a site ends early via End survey early / interest gate, prefer Not interested
 * over Fail for knockouts on that same terminating question. Other Fail knockouts stay fail.
 */
function applyEarlyExitDisposition(def, answers, score) {
    if (!def || !Array.isArray(def.questions)) return score;
    const earlyQs = def.questions.filter((q) => answerTriggersEndSurvey(q, answers));
    if (!earlyQs.length) return score;

    const earlyIds = new Set(earlyQs.map((q) => String(q.id)));
    const knockouts = Array.isArray(score?.knockouts) ? score.knockouts.map((k) => ({ ...k })) : [];

    earlyQs.forEach((earlyQ) => {
        const ans = findAnswerForQuestionId(answers, earlyQ.id);
        const ansVal = ans && !ans.skipped ? normalizeAnswerValue(ans.value) : '';
        const existing = knockouts.find((k) => k && String(k.questionId) === String(earlyQ.id));
        if (existing) {
            existing.disposition = 'not_interested';
            existing.reason = 'Site not interested';
        } else {
            knockouts.push({
                questionId: earlyQ.id,
                label: earlyQ.label || earlyQ.id,
                answer: ansVal || '(ended early)',
                reason: 'Site not interested',
                disposition: 'not_interested',
            });
        }
    });

    const hasOtherFail = knockouts.some((k) => k
        && k.disposition !== 'not_interested'
        && !earlyIds.has(String(k.questionId)));
    const outcome = hasOtherFail ? 'fail' : 'not_interested';

    return {
        ...(score && typeof score === 'object' ? score : {
            earned: 0,
            totalWeight: 0,
            pct: 0,
            passThreshold: 70,
            borderlineThreshold: 50,
            byCategory: {},
            scoredQuestionCount: 0,
            hasScoring: true,
        }),
        outcome,
        knockouts,
        scoredAt: new Date().toISOString(),
        hasScoring: true,
    };
}

async function computeScore(getContainer, surveyId, answers) {
    try {
        const defC = getContainer('site-survey-definitions');
        const defRead = await defC.item(surveyId, surveyId).read();
        const def = defRead.resource;
        const scored = scoreAnswers(def, answers);
        return applyEarlyExitDisposition(def, answers, scored);
    } catch (_) {
        return null;
    }
}

async function findLatestLiveResponse(getContainer, { siteId, siteIds, surveyId, targetRole }) {
    const rspC = getContainer('site-survey-responses');
    const role = normalizeRole(targetRole);
    const ids = [...new Set(
        (Array.isArray(siteIds) && siteIds.length ? siteIds : [siteId])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
    )];
    if (!ids.length || !surveyId) return null;
    const clauses = ids.map((_, i) => `c.siteId = @s${i}`);
    const parameters = [
        ...ids.map((id, i) => ({ name: `@s${i}`, value: id })),
        { name: '@surveyId', value: String(surveyId) },
        { name: '@targetRole', value: role },
    ];
    const { resources } = await rspC.items
        .query(
            {
                query:
                    `SELECT * FROM c WHERE (${clauses.join(' OR ')}) AND c.surveyId = @surveyId AND LOWER(c.targetRole) = @targetRole AND (NOT IS_DEFINED(c._archived) OR c._archived != true)`,
                parameters,
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

function normalizeSiteNameForLink(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(llc|inc|ltd|pc|pa|pllc|corp|co|the)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function resolveRelatedSiteIds(getContainer, siteId) {
    const ids = new Set([String(siteId)]);
    let seedName = '';
    try {
        const read = await getContainer('sites').item(String(siteId), String(siteId)).read();
        const site = read.resource;
        if (site) {
            seedName = site.name || '';
            if (Array.isArray(site.legacySiteIds)) {
                site.legacySiteIds.forEach((id) => {
                    if (id) ids.add(String(id));
                });
            }
            if (site.promotedFromLegacySiteId) ids.add(String(site.promotedFromLegacySiteId));
        }
    } catch (_) {
        /* may be a legacy id */
    }

    // Reverse: legacy rows pointing at this live site
    try {
        const { resources } = await getContainer('legacy-sites')
            .items.query(
                {
                    query: 'SELECT c.id, c.name, c.linkedArtemisSiteId FROM c WHERE c.linkedArtemisSiteId = @liveId',
                    parameters: [{ name: '@liveId', value: String(siteId) }],
                },
                { enableCrossPartitionQuery: true }
            )
            .fetchAll();
        (resources || []).forEach((leg) => {
            if (leg?.id) ids.add(String(leg.id));
            if (!seedName && leg?.name) seedName = leg.name;
        });
    } catch (_) {
        /* ignore */
    }

    // If assignment/response used a legacy id, pull its linked live twin + siblings
    try {
        const legRead = await getContainer('legacy-sites').item(String(siteId), String(siteId)).read();
        const leg = legRead.resource;
        if (leg) {
            if (!seedName) seedName = leg.name || '';
            if (leg.linkedArtemisSiteId) {
                ids.add(String(leg.linkedArtemisSiteId));
                try {
                    const liveRead = await getContainer('sites')
                        .item(String(leg.linkedArtemisSiteId), String(leg.linkedArtemisSiteId))
                        .read();
                    const live = liveRead.resource;
                    if (live) {
                        if (Array.isArray(live.legacySiteIds)) {
                            live.legacySiteIds.forEach((id) => {
                                if (id) ids.add(String(id));
                            });
                        }
                        if (live.promotedFromLegacySiteId) ids.add(String(live.promotedFromLegacySiteId));
                    }
                } catch (_) {
                    /* ignore */
                }
            }
        }
    } catch (_) {
        /* not a legacy id */
    }

    // Name fallback when explicit links are missing (unique match only)
    const key = normalizeSiteNameForLink(seedName);
    if (key) {
        try {
            const { resources: liveHits } = await getContainer('sites')
                .items.query({ query: 'SELECT c.id, c.name, c.legacySiteIds, c.promotedFromLegacySiteId FROM c' }, { enableCrossPartitionQuery: true })
                .fetchAll();
            const nameHits = (liveHits || []).filter((s) => normalizeSiteNameForLink(s?.name) === key);
            if (nameHits.length === 1) {
                const live = nameHits[0];
                ids.add(String(live.id));
                (live.legacySiteIds || []).forEach((id) => {
                    if (id) ids.add(String(id));
                });
                if (live.promotedFromLegacySiteId) ids.add(String(live.promotedFromLegacySiteId));
            }
        } catch (_) {
            /* ignore */
        }
        try {
            const { resources: legHits } = await getContainer('legacy-sites')
                .items.query({ query: 'SELECT c.id, c.name, c.linkedArtemisSiteId FROM c' }, { enableCrossPartitionQuery: true })
                .fetchAll();
            const nameHits = (legHits || []).filter((s) => normalizeSiteNameForLink(s?.name) === key);
            if (nameHits.length === 1 && nameHits[0]?.id) {
                ids.add(String(nameHits[0].id));
                if (nameHits[0].linkedArtemisSiteId) ids.add(String(nameHits[0].linkedArtemisSiteId));
            }
        } catch (_) {
            /* ignore */
        }
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
    const relatedSiteIds = await resolveRelatedSiteIds(getContainer, body.siteId);
    const prior = await findLatestLiveResponse(getContainer, {
        ...body,
        siteIds: relatedSiteIds,
    });
    const score = await computeScore(getContainer, body.surveyId, body.answers);
    if (score !== null) body.score = score;
    const siteDisposition = score?.outcome === 'not_interested' || score?.outcome === 'fail'
        ? score.outcome
        : null;
    if (siteDisposition) body.siteDisposition = siteDisposition;

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
        const updatedScore = reScore !== null ? reScore : body.score ?? prior.score ?? null;
        const updatedDisposition = updatedScore?.outcome === 'not_interested' || updatedScore?.outcome === 'fail'
            ? updatedScore.outcome
            : null;
        const updated = {
            ...prior,
            ...body,
            id: prior.id,
            answers: mergedAnswers,
            submittedAt: now,
            updatedAt: now,
            _resubmitCount: (prior._resubmitCount || 0) + 1,
            score: updatedScore,
            siteDisposition: updatedDisposition || undefined,
        };
        if (!updatedDisposition) delete updated.siteDisposition;
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
            siteDisposition: updatedDisposition || null,
        };
        delete asgSubmitted.draftAnswers;
        delete asgSubmitted.draftSavedAt;
        await asgC.items.upsert(asgSubmitted);

        return { resource: { ...resource, resubmitted: true }, resubmitted: true, created: false };
    }

    const created = { ...body, id: generateId(), createdAt: now };
    if (!siteDisposition) delete created.siteDisposition;
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
        siteDisposition: siteDisposition || null,
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
    buildSiteRecordPrefill,
    mergeAnswers,
    scoreAnswers,
    applyEarlyExitDisposition,
    answerTriggersEndSurvey,
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
