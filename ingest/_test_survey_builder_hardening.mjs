/**
 * Survey builder / public paging + branching regression checks.
 * Run: node ingest/_test_survey_builder_hardening.mjs
 */

// Mirror api/survey-secure-routes.js buildSurveyPages (keep in sync)
function buildSurveyPagesLocal(questions) {
    const list = Array.isArray(questions) ? questions : [];
    const anyExplicitSection = list.some((q) => String(q?.section || '').trim());
    const pages = [];
    list.forEach((q, idx) => {
        let key;
        if (anyExplicitSection) {
            key = String(q.section || '').trim() || 'Page 1';
        } else {
            key = String(q.section || q.category || '').trim() || 'Questions';
        }
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
        { id: 'a', section: 'Page 1', category: 'Patient access' },
        { id: 'b', section: 'Page 1', category: 'Staffing' },
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
        { id: 'a', section: 'Page 1', category: 'Experience' },
        { id: 'b', section: 'Page 1', category: 'Logistics' },
        { id: 'c', section: 'Page 1', category: 'Regulatory' },
    ]);
    assert(pages.length === 1, 'scoring categories must not create pages when section is set');
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
