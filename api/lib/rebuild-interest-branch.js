/**
 * Lock Kari's ReBUILD not-interested branch so builder saves / syncs can't wipe it.
 *
 * Contract (do not change without Kari + ops sign-off):
 *  Q1 interest (Yes/No) — No does NOT end the survey
 *  Q2 reasons — show only when Q1 = No; any reason ends early
 *  Comments — stay visible through end-early (showThroughQuestionId)
 *  Reason choices — disposition not_interested
 */
const REBUILD_SURVEY_ID = 'survey-rebuild-mytx272am-201';
const INTEREST_ID = 'rebuild_013_has-the-investigator-reviewed-the-protoc';
const REASON_ID = 'rebuild_014_if-not-interested-what-is-the-reason';
const COMMENTS_ID = 'rebuild_016_do-you-have-any-additional-comments-you-';

/** Locked Kari reason choices — never trust a corrupted/split live list. */
const REASON_OPTIONS = [
    'Lack of patients meeting eligibility criteria',
    'Competing studies, ongoing or planned',
    'Lack of time and/or research staff',
    'Lack of equipment',
    'Protocol-related concerns',
    'Other',
];

function isRebuildSurveyDoc(doc) {
    if (!doc || typeof doc !== 'object') return false;
    const id = String(doc.id || '').trim();
    const code = String(doc.studyCode || '').trim().toUpperCase();
    return id === REBUILD_SURVEY_ID || code === 'MYTX272AM-201';
}

/**
 * Re-assert branching + not_interested scoring on the live definition shape.
 * Safe to call repeatedly. Mutates `doc` in place. Returns true if anything changed.
 */
function ensureRebuildInterestBranching(doc) {
    if (!isRebuildSurveyDoc(doc)) return false;
    const qs = Array.isArray(doc.questions) ? doc.questions : null;
    if (!qs || !qs.length) return false;

    const byId = new Map(qs.map((q) => [String(q?.id || ''), q]));
    const interest = byId.get(INTEREST_ID);
    const reason = byId.get(REASON_ID);
    const comments = byId.get(COMMENTS_ID);
    if (!interest || !reason) return false;

    let changed = false;
    const snap = (v) => JSON.stringify(v);

    // Q1: never end-early on No (reasons must still show)
    if (interest.logic && interest.logic.endSurveyIf) {
        const nextLogic = { ...interest.logic };
        delete nextLogic.endSurveyIf;
        interest.logic = Object.keys(nextLogic).length ? nextLogic : undefined;
        changed = true;
    }
    const wantInterestScore = [
        { value: 'Yes', points: 10 },
        { value: 'No', points: 0 },
    ];
    if (snap(interest.scoringOptions || []) !== snap(wantInterestScore)) {
        interest.scoringOptions = wantInterestScore;
        changed = true;
    }

    const opts = REASON_OPTIONS.slice();
    if (snap(reason.options || []) !== snap(opts)) {
        reason.options = opts;
        changed = true;
    }
    if (String(reason.type || '').toLowerCase() !== 'multiselect') {
        reason.type = 'multiselect';
        changed = true;
    }

    const wantReasonLogic = {
        showIf: { questionId: INTEREST_ID, equals: 'No' },
        endSurveyIf: {
            includesAny: opts.slice(),
            showThroughQuestionId: COMMENTS_ID,
        },
    };
    if (snap(reason.logic || null) !== snap(wantReasonLogic)) {
        reason.logic = wantReasonLogic;
        changed = true;
    }

    const wantReasonScore = opts.map((o) => ({
        value: o,
        points: 0,
        knockout: true,
        notInterested: true,
        disposition: 'not_interested',
    }));
    if (snap(reason.scoringOptions || []) !== snap(wantReasonScore)) {
        reason.scoringOptions = wantReasonScore;
        changed = true;
    }

    if (comments) {
        const wantCommentsLogic = { showIf: { questionId: INTEREST_ID, equals: 'No' } };
        if (snap(comments.logic || null) !== snap(wantCommentsLogic)) {
            comments.logic = wantCommentsLogic;
            changed = true;
        }
        if (comments.required !== false) {
            comments.required = false;
            changed = true;
        }
        if (String(comments.type || '').toLowerCase() !== 'textarea') {
            comments.type = 'textarea';
            changed = true;
        }
    }

    return changed;
}

module.exports = {
    REBUILD_SURVEY_ID,
    INTEREST_ID,
    REASON_ID,
    COMMENTS_ID,
    REASON_OPTIONS,
    isRebuildSurveyDoc,
    ensureRebuildInterestBranching,
};
