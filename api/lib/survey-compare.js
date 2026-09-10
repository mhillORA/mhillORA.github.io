/**
 * Compare two site-survey responses (or answer arrays).
 * Status buckets: changed | unchanged | unanswered
 */
const GENERAL_FEASIBILITY_SURVEY_ID = 'survey-general-feasibility';
const GENERAL_FEASIBILITY_SHORT_SURVEY_ID = 'survey-general-feasibility-short';
const GENERAL_FEASIBILITY_SURVEY_IDS = new Set([
    GENERAL_FEASIBILITY_SURVEY_ID,
    GENERAL_FEASIBILITY_SHORT_SURVEY_ID,
]);

/** Compact GF uses the same question ids as Long so prefill/deltas stay aligned. */
const GENERAL_FEASIBILITY_SHORT_QUESTION_IDS = [
    'gf_01_date-of-response',
    'gf_02_site-name',
    'gf_00_name',
    'gsf_005_respondent-email',
    'gf_15_research-contact',
    'gf_16_poc-email',
    'gf_17_poc-role',
    'gf_03_address',
    'gf_05_practice-setting',
    'gf_19_research-experience',
    'gf_20_please-indicate-the-types-of-ophthalmic-studies-your-sit',
    'gf_06_investigators',
    'gsf_028_which-ophthalmic-indications-does-your-site-mana',
    'gf_25_equipment',
    'gf_29_central-irb',
    'gf_30_contracting-contact',
    'gsf_091_contracting-budgeting-contact-email',
];

function normalizeGeneralFeasibilityVariant(raw) {
    const v = String(raw || 'long').trim().toLowerCase();
    if (v === 'none' || v === 'off' || v === 'skip') return 'none';
    if (v === 'short' || v === 'sm') return 'short';
    return 'long';
}

function isGeneralFeasibilitySurveyId(id) {
    return GENERAL_FEASIBILITY_SURVEY_IDS.has(String(id || ''));
}

function normalizeQuestionLabel(label) {
    return String(label || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function readAnswerValue(a) {
    if (!a || typeof a !== 'object') return '';
    const v = a.value ?? a.answer ?? a.answerText ?? a.response ?? a.text ?? null;
    if (v == null) return '';
    if (typeof v === 'object') {
        try {
            return String(v.label ?? v.value ?? JSON.stringify(v)).trim();
        } catch (_) {
            return '';
        }
    }
    return String(v).trim();
}

function answerIsFilled(a) {
    return readAnswerValue(a) !== '';
}

function buildAnswerLookup(answers) {
    const byId = new Map();
    const byLabel = new Map();
    (Array.isArray(answers) ? answers : []).forEach((a) => {
        if (!a) return;
        const value = readAnswerValue(a);
        const filled = value !== '';
        const entry = {
            value,
            filled,
            questionId: String(a.questionId ?? a.id ?? a.qid ?? ''),
            label: String(a.label || a.title || '').trim(),
            libraryQuestionId: a.libraryQuestionId ? String(a.libraryQuestionId) : '',
            skipped: !!a.skipped,
        };
        if (entry.questionId) byId.set(entry.questionId, entry);
        const norm = normalizeQuestionLabel(entry.label);
        if (norm) byLabel.set(norm, entry);
        if (entry.libraryQuestionId) byId.set(`lib:${entry.libraryQuestionId}`, entry);
    });
    return { byId, byLabel };
}

function resolveFromLookup(lookup, { questionId, label, libraryQuestionId }) {
    if (questionId && lookup.byId.has(String(questionId))) return lookup.byId.get(String(questionId));
    if (libraryQuestionId && lookup.byId.has(`lib:${libraryQuestionId}`)) {
        return lookup.byId.get(`lib:${libraryQuestionId}`);
    }
    const norm = normalizeQuestionLabel(label);
    if (norm && lookup.byLabel.has(norm)) return lookup.byLabel.get(norm);
    return null;
}

/**
 * @returns {{
 *   summary: { changed: number, unchanged: number, unanswered: number, total: number },
 *   changed: object[],
 *   unchanged: object[],
 *   unanswered: object[],
 *   rows: object[]
 * }}
 */
function compareSurveyResponses({ current, previous, questions } = {}) {
    const curLookup = buildAnswerLookup(current?.answers ?? current);
    const prevLookup = buildAnswerLookup(previous?.answers ?? previous);
    const qs = Array.isArray(questions) ? questions : [];

    const keys = new Map(); // key -> meta

    const remember = (meta) => {
        const qid = meta.questionId ? String(meta.questionId) : '';
        const norm = normalizeQuestionLabel(meta.label);
        const lib = meta.libraryQuestionId ? String(meta.libraryQuestionId) : '';
        const key = qid || (lib ? `lib:${lib}` : '') || (norm ? `label:${norm}` : '');
        if (!key) return;
        if (!keys.has(key)) {
            keys.set(key, {
                questionId: qid || null,
                libraryQuestionId: lib || null,
                label: meta.label || qid || lib || 'Question',
                key,
            });
        } else if (meta.label && keys.get(key).label === keys.get(key).questionId) {
            keys.get(key).label = meta.label;
        }
    };

    qs.forEach((q, idx) => {
        remember({
            questionId: q.id || `q_${idx}`,
            label: q.label || q.title || '',
            libraryQuestionId: q.libraryQuestionId || '',
        });
    });
    for (const entry of curLookup.byId.values()) {
        if (String(entry.questionId || '').startsWith('lib:')) continue;
        remember(entry);
    }
    for (const entry of prevLookup.byId.values()) {
        if (String(entry.questionId || '').startsWith('lib:')) continue;
        remember(entry);
    }
    for (const entry of curLookup.byLabel.values()) remember(entry);
    for (const entry of prevLookup.byLabel.values()) remember(entry);

    const rows = [];
    for (const meta of keys.values()) {
        const cur = resolveFromLookup(curLookup, meta);
        const prev = resolveFromLookup(prevLookup, meta);
        const currentValue = cur?.filled ? cur.value : '';
        const previousValue = prev?.filled ? prev.value : '';
        const currentAnswered = !!cur?.filled;
        const previousAnswered = !!prev?.filled;

        let status = 'unanswered';
        if (!currentAnswered) {
            status = 'unanswered';
        } else if (!previousAnswered) {
            // Answered now, nothing on prior file — treat as unchanged baseline (first fill)
            status = 'unchanged';
        } else if (normalizeQuestionLabel(currentValue) === normalizeQuestionLabel(previousValue)
            || String(currentValue) === String(previousValue)) {
            status = 'unchanged';
        } else {
            status = 'changed';
        }

        rows.push({
            questionId: meta.questionId,
            libraryQuestionId: meta.libraryQuestionId,
            label: meta.label,
            status,
            currentValue: currentAnswered ? currentValue : null,
            previousValue: previousAnswered ? previousValue : null,
            currentAnswered,
            previousAnswered,
            flagNotAnswered: !currentAnswered,
        });
    }

    rows.sort((a, b) => {
        const order = { changed: 0, unanswered: 1, unchanged: 2 };
        const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
        if (d !== 0) return d;
        return String(a.label || '').localeCompare(String(b.label || ''));
    });

    const changed = rows.filter((r) => r.status === 'changed');
    const unchanged = rows.filter((r) => r.status === 'unchanged');
    const unanswered = rows.filter((r) => r.status === 'unanswered');

    return {
        summary: {
            changed: changed.length,
            unchanged: unchanged.length,
            unanswered: unanswered.length,
            total: rows.length,
        },
        changed,
        unchanged,
        unanswered,
        rows,
        currentResponseId: current?.id || null,
        previousResponseId: previous?.id || null,
        currentSurveyId: current?.surveyId || null,
        previousSurveyId: previous?.surveyId || null,
        currentSubmittedAt: current?.submittedAt || current?.updatedAt || null,
        previousSubmittedAt: previous?.submittedAt || previous?.updatedAt || null,
    };
}

/**
 * Prepend General Feasibility questions; keep instance ids from gen feas so prior answers match.
 * Study-specific questions that duplicate gen feas (same id or label) are dropped from the tail.
 */
function mergeGeneralFeasibilityQuestions(studyQuestions, genQuestions, { studySurveyId } = {}) {
    const gen = Array.isArray(genQuestions) ? genQuestions : [];
    const study = Array.isArray(studyQuestions) ? studyQuestions : [];
    // Standing alone as GF long/short — do not prepend again.
    if (studySurveyId && isGeneralFeasibilitySurveyId(studySurveyId)) {
        return study.map((q) => ({ ...q, _fromGeneralFeasibility: true }));
    }
    if (!gen.length) return study.map((q) => ({ ...q }));

    const seenIds = new Set();
    const seenLabels = new Set();
    const out = [];

    gen.forEach((q, idx) => {
        const id = String(q.id || `gf_${idx}`);
        const label = normalizeQuestionLabel(q.label || q.title);
        seenIds.add(id);
        if (label) seenLabels.add(label);
        out.push({
            ...q,
            id,
            _fromGeneralFeasibility: true,
            libraryQuestionId: q.libraryQuestionId || id,
        });
    });

    study.forEach((q, idx) => {
        const id = String(q.id || `q_${idx}`);
        const label = normalizeQuestionLabel(q.label || q.title);
        if (seenIds.has(id)) return;
        if (label && seenLabels.has(label)) return;
        seenIds.add(id);
        if (label) seenLabels.add(label);
        out.push({ ...q, id, _fromGeneralFeasibility: false });
    });

    return out;
}

module.exports = {
    GENERAL_FEASIBILITY_SURVEY_ID,
    GENERAL_FEASIBILITY_SHORT_SURVEY_ID,
    GENERAL_FEASIBILITY_SURVEY_IDS,
    GENERAL_FEASIBILITY_SHORT_QUESTION_IDS,
    normalizeGeneralFeasibilityVariant,
    isGeneralFeasibilitySurveyId,
    normalizeQuestionLabel,
    readAnswerValue,
    answerIsFilled,
    buildAnswerLookup,
    compareSurveyResponses,
    mergeGeneralFeasibilityQuestions,
};
