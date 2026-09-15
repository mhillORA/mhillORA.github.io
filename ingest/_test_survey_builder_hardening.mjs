/**
 * Survey builder / public paging + branching regression checks.
 * Run: node ingest/_test_survey_builder_hardening.mjs
 */

// Mirror api/survey-secure-routes.js buildSurveyPages (keep in sync)
function resolvePublicSectionKeyLocal(q) {
    const section = String(q?.section || '').trim();
    const weakSection = !section || /^(page\s*\d+|questions)$/i.test(section);
    if (section && !weakSection) return section;
    const legacy = String(q?.category || '').trim();
    if (legacy && !/^(general|questions|page\s*\d+)$/i.test(legacy)) return legacy;
    return section || 'Questions';
}

function isWeakPublicSectionKey(key) {
    return !key || /^(page\s*\d+|questions)$/i.test(String(key).trim());
}

function buildSurveyPagesLocal(questions) {
    const list = Array.isArray(questions) ? questions : [];
    const pages = [];
    let lastStrongKey = '';
    list.forEach((q, idx) => {
        let key = resolvePublicSectionKeyLocal(q);
        if (isWeakPublicSectionKey(key) && lastStrongKey) key = lastStrongKey;
        else if (!isWeakPublicSectionKey(key)) lastStrongKey = key;
        if (!pages.length || pages[pages.length - 1].key !== key) {
            pages.push({ key, title: key, questionIds: [], indexes: [] });
        }
        pages[pages.length - 1].questionIds.push(q.id || `q_${idx}`);
        pages[pages.length - 1].indexes.push(idx);
    });
    return pages;
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

{
    const onePage = buildSurveyPagesLocal([
        { id: 'a', section: 'Page 1' },
        { id: 'b', section: 'Page 1' },
    ]);
    assert(onePage.length === 1, `expected 1 page when same section, got ${onePage.length}`);
    assert(onePage[0].questionIds.join(',') === 'a,b', 'page should keep question order');
}

{
    const two = buildSurveyPagesLocal([
        { id: 'a', section: 'Site profile' },
        { id: 'b', section: 'Site profile' },
        { id: 'c', section: 'Investigators' },
    ]);
    assert(two.length === 2, `expected 2 pages, got ${two.length}`);
    assert(two[0].key === 'Site profile' && two[1].key === 'Investigators', 'page titles wrong');
    assert(two[0].questionIds.join(',') === 'a,b' && two[1].questionIds.join(',') === 'c', 'page membership wrong');
}

{
    const pages = buildSurveyPagesLocal([
        { id: 'a', section: 'Equipment' },
        { id: 'b', section: 'Equipment', category: 'Logistics' },
        { id: 'c', section: 'Equipment', category: 'Regulatory' },
    ]);
    assert(pages.length === 1, 'scoring categories must not create pages when section is set');
}

{
    // Mighty rebuild bug: follow-ups stamped "Page 1" must stay on prior SECTION
    const rebuildish = buildSurveyPagesLocal([
        { id: 's2a', section: 'SECTION 2: SITE INFORMATION' },
        { id: 's2b', section: 'Page 1' },
        { id: 's2c', section: 'SECTION 2: SITE INFORMATION' },
        { id: 's3a', section: 'SECTION 3: SITE PROFILE' },
        { id: 's3b', section: 'Page 1' },
    ]);
    assert(rebuildish.length === 2, `follow-up Page 1 must not shatter pages, got ${rebuildish.length}`);
    assert(rebuildish[0].questionIds.join(',') === 's2a,s2b,s2c', 'section 2 membership');
    assert(rebuildish[1].questionIds.join(',') === 's3a,s3b', 'section 3 membership');
}

{
    const legacy = buildSurveyPagesLocal([
        { id: 'g1', category: 'SECTION 1: CONTACT' },
        { id: 'g2', category: 'SECTION 1: CONTACT' },
        { id: 'g3', category: 'SECTION 2: SITE' },
    ]);
    assert(legacy.length === 2, `legacy GF should split by category, got ${legacy.length}`);
}

function normLogicToken(s) {
    return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function logicTokensEquivalent(a, b) {
    const x = normLogicToken(a);
    const y = normLogicToken(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const yes = new Set(['yes', 'y', 'true']);
    const no = new Set(['no', 'n', 'false']);
    if (yes.has(x) && yes.has(y)) return true;
    if (no.has(x) && no.has(y)) return true;
    if (x.startsWith('other') && y === 'other') return true;
    if (y.startsWith('other') && x === 'other') return true;
    return false;
}
function selectedHasValue(selected, want) {
    const w = String(want ?? '').trim();
    if (!w) return false;
    return (selected || []).some((s) => logicTokensEquivalent(s, w));
}

assert(selectedHasValue(['No'], 'No') === true, 'No===No');
assert(selectedHasValue(['No'], 'no') === true, 'case-insensitive No');
assert(selectedHasValue(['Yes'], 'No') === false, 'Yes!==No');
assert(selectedHasValue(['Other'], 'Other') === true, 'Other match');
assert(selectedHasValue(['Anterior', 'Other'], 'Other') === true, 'multiselect includes Other');
assert(selectedHasValue([], 'No') === false, 'empty selected must not match');

/** Mirror site-survey.html endSurveyIf + knockout evaluation */
function evalEndSurveyIf(selected, endIf, question) {
    const anyList = [];
    const pushAny = (v) => {
        const s = String(v ?? '').trim();
        if (!s) return;
        if (!anyList.some((x) => x.toLowerCase() === s.toLowerCase())) anyList.push(s);
    };
    if (endIf && typeof endIf === 'object' && Array.isArray(endIf.includesAny)) {
        endIf.includesAny.forEach(pushAny);
    }
    (Array.isArray(question?.scoringOptions) ? question.scoringOptions : []).forEach((o) => {
        if (o && (o.knockout === true || o.fail === true)) pushAny(o.value);
    });
    (Array.isArray(question?.knockoutFailValues) ? question.knockoutFailValues : []).forEach(pushAny);

    if (endIf && typeof endIf === 'object') {
        if (endIf.includes != null && endIf.includes !== '') {
            if (selectedHasValue(selected, endIf.includes)) return true;
        }
        if (endIf.equals != null && endIf.equals !== '') {
            if (selectedHasValue(selected, endIf.equals)) return true;
        }
    }
    if (anyList.length && anyList.some((v) => selectedHasValue(selected, v))) return true;
    return false;
}

function applyEndSurveySkip(questions, answersById) {
    // answersById: { qid: string[] }
    let endAt = -1;
    const visible = questions.map((q, i) => {
        if (endAt >= 0) return { id: q.id, skipped: true, endSkipped: true };
        const selected = answersById[q.id] || [];
        if (evalEndSurveyIf(selected, q.logic?.endSurveyIf, q)) endAt = i;
        return { id: q.id, skipped: false, endSkipped: false };
    });
    if (endAt >= 0) {
        for (let i = endAt + 1; i < visible.length; i++) {
            visible[i].skipped = true;
            visible[i].endSkipped = true;
        }
    }
    return { endAt, visible };
}

{
    const qs = [
        { id: 'q1', logic: { endSurveyIf: { equals: 'No' } } },
        { id: 'q2' },
        { id: 'q3' },
    ];
    const ended = applyEndSurveySkip(qs, { q1: ['No'] });
    assert(ended.endAt === 0, 'end should fire on q1');
    assert(ended.visible[0].skipped === false, 'terminating question stays');
    assert(ended.visible[1].endSkipped && ended.visible[2].endSkipped, 'later questions end-skipped');
    const continued = applyEndSurveySkip(qs, { q1: ['Yes'] });
    assert(continued.endAt === -1, 'Yes must not end');
    assert(continued.visible.every((v) => !v.endSkipped), 'all questions remain');
}

{
    const qs = [
        {
            id: 'q1',
            scoringOptions: [
                { value: 'Yes', points: 10 },
                { value: 'No', points: 0, knockout: true },
            ],
        },
        { id: 'q2' },
        { id: 'q3' },
    ];
    const ended = applyEndSurveySkip(qs, { q1: ['No'] });
    assert(ended.endAt === 0, 'knockout alone should end');
    assert(ended.visible[1].endSkipped && ended.visible[2].endSkipped, 'knockout skips later');
    const continued = applyEndSurveySkip(qs, { q1: ['Yes'] });
    assert(continued.endAt === -1, 'knockout Yes continues');
}

{
    const qs = [
        { id: 'a' },
        { id: 'b', logic: { endSurveyIf: { includes: 'Decline' } } },
        { id: 'c' },
    ];
    const r = applyEndSurveySkip(qs, { a: ['x'], b: ['Keep going', 'Decline'] });
    assert(r.endAt === 1, 'multiselect includes ends at b');
    assert(r.visible[2].endSkipped === true, 'c skipped after decline');
}

/** Clone must remap showIf.questionId onto new question ids */
function remapCloneLogic(oldQuestions) {
    const idMap = new Map();
    const mapped = oldQuestions.map((q, qi) => {
        const oldId = q.id || `q_legacy_${qi}`;
        const newId = `clone_${qi}`;
        idMap.set(String(oldId), newId);
        const logic = q.logic ? JSON.parse(JSON.stringify(q.logic)) : null;
        return { ...q, id: newId, logic };
    });
    mapped.forEach((q) => {
        const dep = q.logic?.showIf?.questionId;
        if (dep && idMap.has(String(dep))) q.logic.showIf.questionId = idMap.get(String(dep));
    });
    return mapped;
}

{
    const cloned = remapCloneLogic([
        { id: 'gsf_021', type: 'radio', options: ['Yes', 'No'] },
        { id: 'gsf_022', type: 'text', logic: { showIf: { questionId: 'gsf_021', equals: 'Yes' } } },
        { id: 'gsf_023', type: 'text', logic: { showIf: { questionId: 'gsf_021', equals: 'No' } } },
    ]);
    assert(cloned[0].id === 'clone_0', 'parent id remapped');
    assert(cloned[1].logic.showIf.questionId === 'clone_0', 'child showIf remapped to new parent');
    assert(cloned[2].logic.showIf.questionId === 'clone_0', 'second child remapped');
    assert(cloned[1].logic.showIf.equals === 'Yes', 'equals preserved');
}

/** Builder must keep equals even when value not picked yet (do not coerce to notEmpty) */
function resolveShowIfOp(showIf) {
    if (!showIf || typeof showIf !== 'object') return 'equals';
    if (showIf.notEmpty === true) return 'notEmpty';
    if (Object.prototype.hasOwnProperty.call(showIf, 'notOnly')) return 'notOnly';
    if (Object.prototype.hasOwnProperty.call(showIf, 'includesAny')) return 'includesAny';
    if (Object.prototype.hasOwnProperty.call(showIf, 'includes')) return 'includes';
    if (Object.prototype.hasOwnProperty.call(showIf, 'equals')) return 'equals';
    if (showIf.questionId) return 'equals';
    return 'equals';
}
assert(resolveShowIfOp({ questionId: 'a', equals: '' }) === 'equals', 'empty equals stays equals');
assert(resolveShowIfOp({ questionId: 'a', equals: 'No' }) === 'equals', 'equals No');
assert(resolveShowIfOp({ questionId: 'a', notEmpty: true }) === 'notEmpty', 'notEmpty');
assert(resolveShowIfOp({ questionId: 'a', includes: '' }) === 'includes', 'empty includes stays includes');

/** End-early checkbox stays on with empty value in memory */
function endIfOn(logic) {
    return !!(logic && logic.endSurveyIf && typeof logic.endSurveyIf === 'object');
}
assert(endIfOn({ endSurveyIf: { equals: '' } }) === true, 'end checkbox on with empty equals');
assert(endIfOn({ endSurveyIf: { equals: 'No' } }) === true, 'end checkbox on with No');
assert(endIfOn({ showIf: { questionId: 'x' } }) === false, 'no endSurveyIf → off');

/** includesAny UI: when choice checkboxes exist, empty selection must not keep stale backup */
function readIncludesAnyFromUi({ choiceBoxesPresent, checked, hiddenBackup }) {
    if (choiceBoxesPresent) return checked.join(' || ');
    return String(hiddenBackup || '');
}
assert(readIncludesAnyFromUi({ choiceBoxesPresent: true, checked: [], hiddenBackup: 'A || B' }) === '', 'cleared checkboxes win over backup');
assert(readIncludesAnyFromUi({ choiceBoxesPresent: true, checked: ['A'], hiddenBackup: 'A || B' }) === 'A', 'checked values used');
assert(readIncludesAnyFromUi({ choiceBoxesPresent: false, checked: [], hiddenBackup: 'A' }) === 'A', 'no checkbox UI can use backup');

function resolveBuilderPageSection(q) {
    const explicit = String(q?.section || '').trim();
    if (explicit) return explicit;
    const cat = String(q?.category || '').trim();
    if (/^section\s+\d+/i.test(cat)) return cat;
    return 'Page 1';
}
assert(resolveBuilderPageSection({ category: 'Patient access' }) === 'Page 1', 'scoring cat must not become page');
assert(resolveBuilderPageSection({ section: 'Investigators' }) === 'Investigators', 'explicit section wins');
assert(resolveBuilderPageSection({ category: 'SECTION 2: SITE' }).startsWith('SECTION 2'), 'legacy SECTION cat ok');

console.log('PASS: survey builder hardening checks');
