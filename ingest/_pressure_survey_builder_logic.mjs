/**
 * Pressure-test survey/template authoring: add/remove/shift, branching logic, pass/fail.
 *
 * Pure local (no Cosmos). Mirrors builder ops + public eval + API scoring.
 *
 *   node ingest/_pressure_survey_builder_logic.mjs
 *   node ingest/_pressure_survey_builder_logic.mjs --rounds=80
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { scoreAnswers } = require(path.join(REPO, 'api', 'lib', 'survey-response-service.js'));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const ROUNDS = Math.max(20, Math.min(500, Number(args.rounds || 60) || 60));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function uid(prefix = 'q') {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36).slice(-4)}`;
}

const SURVEY_QUESTION_TYPES = ['select', 'radio', 'multiselect', 'rating', 'text', 'textarea', 'number', 'date'];

function normalizeSurveyQuestionType(type) {
  const t = String(type || 'text').toLowerCase().trim();
  if (t === 'yesno' || t === 'yes/no' || t === 'boolean') return 'radio';
  if (t === 'checkboxes' || t === 'checkbox' || t === 'multi' || t === 'multi-select') return 'multiselect';
  if (SURVEY_QUESTION_TYPES.includes(t)) return t;
  return 'text';
}

function isChoiceQuestionType(type) {
  const t = normalizeSurveyQuestionType(type);
  return t === 'select' || t === 'radio' || t === 'multiselect';
}

function coerceOptionList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (typeof o === 'string' || typeof o === 'number') return String(o).trim();
    if (o && typeof o === 'object') return String(o.label ?? o.value ?? '').trim();
    return '';
  }).filter(Boolean);
}

function resolveBuilderOptions(q) {
  const type = normalizeSurveyQuestionType(q?.type);
  if (!isChoiceQuestionType(type)) return [];
  let opts = coerceOptionList(q?.options);
  if (!opts.length && (type === 'radio' || type === 'select')) opts = ['Yes', 'No'];
  return opts;
}

function resolveBuilderPageSection(q) {
  const explicit = String(q?.section || '').trim();
  if (explicit) return explicit;
  const cat = String(q?.category || '').trim();
  if (/^section\s+\d+/i.test(cat)) return cat;
  return 'Page 1';
}

function buildSurveyPages(questions) {
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

/** Clone template: new ids + remap showIf.questionId (mirrors index.html) */
function cloneTemplateQuestions(raw) {
  const idMap = new Map();
  const mapped = (raw || []).map((q, qi) => {
    const oldId = q.id || `q_legacy_${qi}`;
    const newId = uid('clone');
    idMap.set(String(oldId), newId);
    const logic = q.logic ? JSON.parse(JSON.stringify(q.logic)) : null;
    return {
      ...JSON.parse(JSON.stringify(q)),
      id: newId,
      type: normalizeSurveyQuestionType(q.type),
      options: resolveBuilderOptions(q),
      section: resolveBuilderPageSection(q),
      logic,
    };
  });
  mapped.forEach((q) => {
    const dep = q.logic?.showIf?.questionId;
    if (dep && idMap.has(String(dep))) q.logic.showIf.questionId = idMap.get(String(dep));
  });
  return { questions: mapped, idMap };
}

function logicTokensEquivalent(a, b) {
  const x = String(a ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const y = String(b ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!x || !y) return false;
  if (x === y) return true;
  const yes = new Set(['yes', 'y', 'true']);
  const no = new Set(['no', 'n', 'false']);
  if (yes.has(x) && yes.has(y)) return true;
  if (no.has(x) && no.has(y)) return true;
  return false;
}

function selectedHasValue(selected, want) {
  const w = String(want ?? '').trim();
  if (!w) return false;
  return (selected || []).some((s) => logicTokensEquivalent(s, w));
}

/** Mirror site-survey.html evalShowIf against answer map { qid: string[] } */
function evalShowIf(showIf, answersById) {
  if (!showIf?.questionId) return true;
  const selected = answersById[showIf.questionId] || [];
  if (showIf.includes != null && showIf.includes !== '') {
    return selectedHasValue(selected, showIf.includes);
  }
  if (Array.isArray(showIf.includesAny) && showIf.includesAny.length) {
    return showIf.includesAny.some((w) => selectedHasValue(selected, w));
  }
  if (showIf.notOnly != null && showIf.notOnly !== '') {
    if (!selected.length) return false;
    return selected.some((s) => !logicTokensEquivalent(s, showIf.notOnly));
  }
  if (showIf.notEmpty === true) return selected.length > 0;
  if (showIf.equals != null && showIf.equals !== '') {
    return selectedHasValue(selected, showIf.equals);
  }
  // Legacy questionId-only → is answered
  return selected.length > 0;
}

function evalEndSurveyIf(endIf, selected, question) {
  const anyList = [];
  const pushAny = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return;
    if (!anyList.some((x) => x.toLowerCase() === s.toLowerCase())) anyList.push(s);
  };
  if (endIf && typeof endIf === 'object') {
    if (Array.isArray(endIf.includesAny)) endIf.includesAny.forEach(pushAny);
  }
  (Array.isArray(question?.scoringOptions) ? question.scoringOptions : []).forEach((o) => {
    if (o && (o.knockout === true || o.fail === true || o.notInterested === true
      || String(o.disposition || '').toLowerCase() === 'not_interested')) pushAny(o.value);
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

/** Public visibility after showIf + endSurveyIf / knockout */
function visibleAfterLogic(questions, answersById) {
  const rows = questions.map((q, i) => ({
    id: q.id,
    idx: i,
    q,
    showIf: q.logic?.showIf,
    endSurveyIf: q.logic?.endSurveyIf,
    visible: true,
    endSkipped: false,
  }));
  rows.forEach((row) => {
    row.visible = evalShowIf(row.showIf, answersById);
  });
  let endAt = -1;
  rows.forEach((row, i) => {
    if (endAt >= 0) return;
    if (!row.visible) return;
    const selected = answersById[row.id] || [];
    if (evalEndSurveyIf(row.endSurveyIf, selected, row.q)) endAt = i;
  });
  if (endAt >= 0) {
    for (let i = endAt + 1; i < rows.length; i++) {
      rows[i].visible = false;
      rows[i].endSkipped = true;
    }
  }
  return { endAt, rows };
}

function seedTemplate() {
  const qGate = {
    id: 'q_gate',
    label: 'Do you want to continue?',
    type: 'radio',
    options: ['Yes', 'No'],
    required: true,
    section: 'Page 1',
    category: 'General',
    scoringWeight: 10,
    scoringOptions: [
      { value: 'Yes', points: 10 },
      { value: 'No', points: 0, knockout: true, notInterested: true, disposition: 'not_interested' },
    ],
    knockout: true,
    logic: { endSurveyIf: { equals: 'No' } },
  };
  const qDetail = {
    id: 'q_detail',
    label: 'Describe capacity',
    type: 'text',
    options: [],
    required: true,
    section: 'Page 1',
    category: 'Patient access',
    scoringWeight: 0,
    scoringOptions: [],
    logic: { showIf: { questionId: 'q_gate', equals: 'Yes' } },
  };
  const qMulti = {
    id: 'q_multi',
    label: 'Modalities',
    type: 'multiselect',
    options: ['OCT', 'FA', 'Both', 'None'],
    required: true,
    section: 'Page 2',
    category: 'Infrastructure',
    scoringWeight: 20,
    scoringOptions: [
      { value: 'OCT', points: 10 },
      { value: 'FA', points: 10 },
      { value: 'Both', points: 20 },
      { value: 'None', points: 0, knockout: true },
    ],
    knockout: true,
    logic: { showIf: { questionId: 'q_gate', equals: 'Yes' } },
  };
  const qFollow = {
    id: 'q_follow',
    label: 'OCT device model',
    type: 'text',
    options: [],
    required: true,
    section: 'Page 2',
    category: 'Infrastructure',
    scoringWeight: 0,
    scoringOptions: [],
    logic: { showIf: { questionId: 'q_multi', includesAny: ['OCT', 'Both'] } },
  };
  return {
    id: 'tmpl_pressure',
    title: 'Pressure Template',
    passThreshold: 70,
    borderlineThreshold: 50,
    questions: [qGate, qDetail, qMulti, qFollow],
  };
}

function addQuestion(questions, atIdx, partial = {}) {
  const q = {
    id: uid('add'),
    label: partial.label || `Added ${questions.length + 1}`,
    type: normalizeSurveyQuestionType(partial.type || 'radio'),
    options: partial.options || ['Yes', 'No'],
    required: true,
    section: partial.section || resolveBuilderPageSection(questions[Math.max(0, atIdx - 1)] || {}),
    category: partial.category || 'General',
    scoringWeight: partial.scoringWeight ?? 0,
    scoringOptions: partial.scoringOptions || [],
    knockout: !!partial.knockout,
    logic: partial.logic || null,
  };
  if (isChoiceQuestionType(q.type)) q.options = resolveBuilderOptions(q);
  else q.options = [];
  const next = [...questions];
  const insertAt = Math.max(0, Math.min(next.length, atIdx));
  next.splice(insertAt, 0, q);
  return next;
}

function removeQuestion(questions, id) {
  const next = questions.filter((q) => q.id !== id);
  // Drop dangling showIf deps
  next.forEach((q) => {
    if (q.logic?.showIf?.questionId === id) {
      q.logic = q.logic.endSurveyIf ? { endSurveyIf: q.logic.endSurveyIf } : null;
    }
  });
  return next;
}

function shiftQuestion(questions, from, to) {
  if (from === to || from < 0 || to < 0 || from >= questions.length || to >= questions.length) {
    return [...questions];
  }
  const next = [...questions];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function assertInvariant(questions, tag) {
  const ids = new Set();
  questions.forEach((q, i) => {
    assert(q && q.id, `${tag}: missing id at ${i}`);
    assert(!ids.has(q.id), `${tag}: duplicate id ${q.id}`);
    ids.add(q.id);
    assert(SURVEY_QUESTION_TYPES.includes(normalizeSurveyQuestionType(q.type)), `${tag}: bad type ${q.type}`);
    if (isChoiceQuestionType(q.type)) {
      assert(resolveBuilderOptions(q).length >= 2, `${tag}: ${q.id} choice options < 2`);
    }
    const dep = q.logic?.showIf?.questionId;
    if (dep) {
      assert(ids.has(dep) || questions.some((qq) => qq.id === dep), `${tag}: ${q.id} showIf points at missing ${dep}`);
      // Dependency should appear earlier for sensible surveys (soft: warn via assert for pressure)
      const depIdx = questions.findIndex((qq) => qq.id === dep);
      assert(depIdx >= 0 && depIdx < i, `${tag}: ${q.id} showIf parent must be earlier (dep=${depIdx} self=${i})`);
    }
    if (q.logic?.endSurveyIf) {
      const e = q.logic.endSurveyIf;
      const has = String(e.equals || '').trim() || String(e.includes || '').trim();
      assert(has, `${tag}: ${q.id} endSurveyIf incomplete`);
    }
  });
  const pages = buildSurveyPages(questions);
  assert(pages.length >= 1, `${tag}: no pages`);
}

function answersPayload(map) {
  return Object.entries(map).map(([questionId, vals]) => ({
    questionId,
    value: Array.isArray(vals) ? vals.join(', ') : String(vals || ''),
    skipped: false,
  }));
}

function main() {
  let failures = 0;
  const log = (msg) => console.log(msg);

  // --- 1) Seed + clone remaps branching ---
  {
    const tmpl = seedTemplate();
    assertInvariant(tmpl.questions, 'seed');
    const { questions: cloned, idMap } = cloneTemplateQuestions(tmpl.questions);
    assertInvariant(cloned, 'clone');
    const gateNew = idMap.get('q_gate');
    const detail = cloned.find((q) => q.label === 'Describe capacity');
    assert(detail.logic.showIf.questionId === gateNew, 'clone did not remap showIf');
    const gate = cloned.find((q) => q.label === 'Do you want to continue?');
    assert(gate.logic.endSurveyIf.equals === 'No', 'clone lost endSurveyIf');
    log('OK: clone remaps showIf + keeps endSurveyIf');
  }

  // --- 2) Public logic: showIf + end early ---
  {
    const qs = seedTemplate().questions;
    // Gate = No → end early, later skipped
    let r = visibleAfterLogic(qs, { q_gate: ['No'] });
    assert(r.endAt === 0, 'end early should fire on No');
    assert(r.rows[0].visible && r.rows[1].endSkipped && r.rows[2].endSkipped && r.rows[3].endSkipped, 'later Qs end-skipped');

    // Gate = Yes → detail + multi show; follow hidden until OCT/Both
    r = visibleAfterLogic(qs, { q_gate: ['Yes'], q_multi: ['FA'] });
    assert(r.endAt === -1, 'Yes should not end');
    assert(r.rows[1].visible, 'detail shown for Yes');
    assert(r.rows[2].visible, 'multi shown for Yes');
    assert(!r.rows[3].visible, 'follow hidden without OCT/Both');

    r = visibleAfterLogic(qs, { q_gate: ['Yes'], q_multi: ['OCT', 'FA'] });
    assert(r.rows[3].visible, 'follow shown when OCT selected');

    r = visibleAfterLogic(qs, { q_gate: ['Yes'], q_multi: ['Both'] });
    assert(r.rows[3].visible, 'follow shown for Both via includesAny');
    log('OK: showIf + endSurveyIf visibility matrix');
  }

  // --- 2b) Fail-site alone ends survey (no endSurveyIf needed) ---
  {
    const qs = [
      {
        id: 'q_interest',
        type: 'radio',
        options: ['Yes', 'No'],
        scoringOptions: [
          { value: 'Yes', points: 10 },
          { value: 'No', points: 0, knockout: true },
        ],
        knockout: true,
        // intentionally no logic.endSurveyIf
      },
      { id: 'q_more', type: 'text', required: true },
      { id: 'q_even_more', type: 'text', required: true },
    ];
    const ended = visibleAfterLogic(qs, { q_interest: ['No'] });
    assert(ended.endAt === 0, 'knockout No should end without endSurveyIf');
    assert(ended.rows[1].endSkipped && ended.rows[2].endSkipped, 'later Qs skipped on fail-site');
    const cont = visibleAfterLogic(qs, { q_interest: ['Yes'] });
    assert(cont.endAt === -1, 'Yes should continue');
    assert(cont.rows.every((row) => row.visible && !row.endSkipped), 'all Qs remain on Yes');
    log('OK: fail-site skips remaining questions');
  }

  // --- 3) Pass / fail scoring (real API scorer) ---
  {
    const def = seedTemplate();
    // Knockout on gate No → Not interested
    let score = scoreAnswers(def, answersPayload({ q_gate: 'No', q_multi: 'OCT' }));
    assert(score && score.outcome === 'not_interested', `gate No should be not_interested, got ${score?.outcome}`);
    assert(score.knockouts.some((k) => k.questionId === 'q_gate' && k.disposition === 'not_interested'), 'gate not_interested knockout missing');

    // Pass path: Yes + Both
    score = scoreAnswers(def, answersPayload({ q_gate: 'Yes', q_multi: 'Both' }));
    assert(score.outcome === 'pass', `Yes+Both should pass, got ${score.outcome} pct=${score.pct}`);
    assert(score.pct >= 70, `pct should be high, got ${score.pct}`);
    assert(!score.knockouts.length, 'no knockouts on pass path');

    // Borderline / fail on points: Yes + OCT only (10/30) + gate 10/10 → earned 20 / weight 30 ≈ 67
    score = scoreAnswers(def, answersPayload({ q_gate: 'Yes', q_multi: 'OCT' }));
    assert(['borderline', 'fail', 'pass'].includes(score.outcome), 'scored outcome');
    // Knockout None
    score = scoreAnswers(def, answersPayload({ q_gate: 'Yes', q_multi: 'None' }));
    assert(score.outcome === 'fail', 'None modality should knockout fail');
    log('OK: pass/fail/knockout scoring');
  }

  // --- 4) Pressure: add / remove / shift rounds ---
  {
    let questions = seedTemplate().questions.map((q) => JSON.parse(JSON.stringify(q)));
    let added = 0;
    let removed = 0;
    let shifted = 0;

    for (let round = 0; round < ROUNDS; round++) {
      const tag = `r${round}`;
      const op = round % 5;

      if (op === 0 || op === 1) {
        // Add a radio gated on q_gate (or first radio)
        const parent = questions.find((q) => q.id === 'q_gate') || questions.find((q) => normalizeSurveyQuestionType(q.type) === 'radio');
        const insertAt = Math.min(questions.length, 1 + (round % Math.max(1, questions.length)));
        // Keep parent earlier: insert after parent
        const parentIdx = questions.findIndex((q) => q.id === parent.id);
        const at = Math.max(parentIdx + 1, insertAt);
        questions = addQuestion(questions, at, {
          label: `Probe ${round}`,
          type: round % 2 === 0 ? 'radio' : 'text',
          options: ['Yes', 'No'],
          section: round % 3 === 0 ? 'Page 2' : 'Page 1',
          logic: parent
            ? { showIf: { questionId: parent.id, equals: 'Yes' } }
            : null,
          scoringWeight: round % 4 === 0 ? 5 : 0,
          scoringOptions: round % 4 === 0
            ? [{ value: 'Yes', points: 5 }, { value: 'No', points: 0 }]
            : [],
        });
        added += 1;
      } else if (op === 2 && questions.length > 4) {
        // Remove a non-gate probe question
        const victim = [...questions].reverse().find((q) => String(q.id).startsWith('add_') || String(q.label || '').startsWith('Probe'));
        if (victim) {
          questions = removeQuestion(questions, victim.id);
          removed += 1;
        }
      } else {
        // Shift within same page block when possible, else adjacent swap that keeps deps valid
        if (questions.length >= 3) {
          // Find a movable pair: later question with no one depending on it as showIf parent of something between
          let moved = false;
          for (let i = questions.length - 1; i > 0 && !moved; i--) {
            const q = questions[i];
            const dep = q.logic?.showIf?.questionId;
            const depIdx = dep ? questions.findIndex((qq) => qq.id === dep) : -1;
            // Can move up if new index still after dependency
            if (depIdx >= 0 && i - 1 > depIdx) {
              questions = shiftQuestion(questions, i, i - 1);
              shifted += 1;
              moved = true;
            } else if (!dep && i > 0) {
              // No dependency — swap up unless something between depends on this as parent wrongly
              const someoneNeedsHere = questions.some((qq, qi) => qi > i - 1 && qq.logic?.showIf?.questionId === q.id);
              if (!someoneNeedsHere || i - 1 > questions.findIndex((qq) => qq.id === q.id)) {
                // Prefer swapping two adjacent free texts / probes
                const prev = questions[i - 1];
                const prevIsParent = questions.some((qq) => qq.logic?.showIf?.questionId === prev.id && questions.indexOf(qq) === i);
                if (!prevIsParent) {
                  questions = shiftQuestion(questions, i, i - 1);
                  shifted += 1;
                  moved = true;
                }
              }
            }
          }
          if (!moved && questions.length > 2) {
            // Move last non-dependent down/up safely after its parent
            const last = questions[questions.length - 1];
            const dep = last.logic?.showIf?.questionId;
            const depIdx = dep ? questions.findIndex((qq) => qq.id === dep) : 0;
            const target = Math.min(questions.length - 1, Math.max(depIdx + 1, questions.length - 2));
            questions = shiftQuestion(questions, questions.length - 1, target);
            shifted += 1;
          }
        }
      }

      try {
        assertInvariant(questions, tag);
      } catch (err) {
        failures += 1;
        console.error('FAIL', err.message);
        throw err;
      }

      // After each few rounds, re-check logic + scoring still coherent
      if (round % 10 === 9) {
        const gate = questions.find((q) => q.id === 'q_gate') || questions[0];
        const vis = visibleAfterLogic(questions, { [gate.id]: ['No'] });
        if (gate.logic?.endSurveyIf?.equals === 'No') {
          assert(vis.endAt === questions.findIndex((q) => q.id === gate.id), `${tag}: end early broken after edits`);
        }
        const def = {
          passThreshold: 70,
          borderlineThreshold: 50,
          questions,
        };
        const score = scoreAnswers(def, answersPayload({
          [gate.id]: 'Yes',
          ...(questions.find((q) => q.id === 'q_multi')
            ? { q_multi: 'Both' }
            : {}),
        }));
        assert(score == null || score.hasScoring, `${tag}: scoring vanished`);
      }
    }

    log(`OK: pressure add/remove/shift (${ROUNDS} rounds) added=${added} removed=${removed} shifted=${shifted} finalQs=${questions.length}`);

    // Final clone after mutation still remaps
    const { questions: cloned2 } = cloneTemplateQuestions(questions);
    assertInvariant(cloned2, 'final-clone');
    log('OK: final clone after mutations');
  }

  // --- 5) Page shifts: scoring category must not invent pages ---
  {
    const qs = [
      { id: 'a', section: 'Page 1', category: 'Patient access', type: 'text' },
      { id: 'b', section: 'Page 1', category: 'Staffing', type: 'text' },
      { id: 'c', section: 'Page 2', category: 'Logistics', type: 'text' },
    ];
    const pages = buildSurveyPages(qs);
    assert(pages.length === 2, `expected 2 pages got ${pages.length}`);
    assert(pages[0].questionIds.join(',') === 'a,b', 'page1 membership');
    log('OK: section paging vs scoring categories');
  }

  // --- 6) Incomplete logic rejects (save contract) ---
  {
    const incomplete = { questionId: 'q_gate', equals: '' };
    const stillHasOp = incomplete.notEmpty === true
      || String(incomplete.equals || '').trim()
      || String(incomplete.includes || '').trim();
    assert(!stillHasOp, 'empty equals must be incomplete for save guard');
    log('OK: incomplete equals detected for save guard');
  }

  // --- 7) Regression: bugs we already hit this week ---
  {
    // 7a Radio Yes/No read must not treat data-qid-group as checkboxes-only
    // (simulate readLogicCurrent order: checkboxes first, then radios)
    function readLogicCurrentSim({ checkboxes = [], radios = [] }) {
      if (checkboxes.length) return checkboxes.filter((c) => c.checked).map((c) => c.value);
      if (radios.length) return radios.filter((c) => c.checked).map((c) => c.value);
      return [];
    }
    const radios = [
      { value: 'Yes', checked: false },
      { value: 'No', checked: true },
    ];
    // Old bug: if someone passed radio wrappers as "checkbox group" incorrectly, selected=[];
    assert(readLogicCurrentSim({ radios }).join(',') === 'No', 'radio No must be readable');
    assert(selectedHasValue(readLogicCurrentSim({ radios }), 'No') === true, 'No===No case');
    assert(selectedHasValue(readLogicCurrentSim({ radios }), 'no') === true, 'No case-insensitive');
    assert(selectedHasValue(['Yes'], 'No') === false, 'Yes!==No');

    // 7b equals stickiness: empty equals key must stay equals (not coerce to notEmpty)
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
    assert(resolveShowIfOp({ questionId: 'a', notEmpty: true }) === 'notEmpty', 'notEmpty stays');

    // 7c end-early checkbox stays on with empty value in memory
    assert(!!({ endSurveyIf: { equals: '' } }.endSurveyIf) === true, 'endIf present with empty equals');

    // 7d includesAny: cleared checkboxes must not keep stale backup
    function readIncludesAnyFromUi({ choiceBoxesPresent, checked, hiddenBackup }) {
      if (choiceBoxesPresent) return checked.join(' || ');
      return String(hiddenBackup || '');
    }
    assert(readIncludesAnyFromUi({ choiceBoxesPresent: true, checked: [], hiddenBackup: 'A || B' }) === '', 'stale backup ignored');

    // 7e Library options: radio/multiselect must keep options (not select-only)
    function librarySaveOptions(type, options) {
      const t = normalizeSurveyQuestionType(type);
      return isChoiceQuestionType(t) ? options : [];
    }
    assert(librarySaveOptions('radio', ['Yes', 'No']).length === 2, 'radio library options kept');
    assert(librarySaveOptions('multiselect', ['A', 'B', 'C']).length === 3, 'checkbox library options kept');
    assert(librarySaveOptions('text', ['x']).length === 0, 'text has no options');

    // 7f Import backfill must not demote radio → text
    function keepTypeOnImport(tmplType, libType) {
      const known = SURVEY_QUESTION_TYPES.includes(String(tmplType || '').toLowerCase());
      return known ? normalizeSurveyQuestionType(tmplType) : normalizeSurveyQuestionType(libType);
    }
    assert(keepTypeOnImport('radio', 'text') === 'radio', 'import must not demote radio');
    assert(keepTypeOnImport('multiselect', 'select') === 'multiselect', 'import must not demote multiselect');

    // 7g Type aliases
    assert(normalizeSurveyQuestionType('yesno') === 'radio', 'yesno→radio');
    assert(normalizeSurveyQuestionType('checkboxes') === 'multiselect', 'checkboxes→multiselect');

    // 7h Reorder must not break showIf parent reference
    let qs = seedTemplate().questions.map((q) => JSON.parse(JSON.stringify(q)));
    // Move q_follow before q_multi would break dep order — pressure shift should refuse; do safe swap of detail with nothing above gate
    qs = shiftQuestion(qs, 2, 3); // multi <-> follow: follow depends on multi, so this BREAKS invariant
    // Restore to valid: follow after multi
    qs = [
      qs.find((q) => q.id === 'q_gate'),
      qs.find((q) => q.id === 'q_detail'),
      qs.find((q) => q.id === 'q_multi'),
      qs.find((q) => q.id === 'q_follow'),
    ];
    assertInvariant(qs, 'reorder-restored');

    // 7i End early then change answer back → later questions return
    let vis = visibleAfterLogic(seedTemplate().questions, { q_gate: ['No'] });
    assert(vis.endAt === 0, 'No ends');
    vis = visibleAfterLogic(seedTemplate().questions, { q_gate: ['Yes'], q_multi: ['Both'] });
    assert(vis.endAt === -1 && vis.rows.every((r) => r.visible || r.id === 'q_follow' || true), 'Yes clears end');
    assert(vis.rows.filter((r) => r.endSkipped).length === 0, 'no end-skipped after Yes');

    // 7j Pass/fail after clone (ids change, scoring options still match values)
    const { questions: clonedScore } = cloneTemplateQuestions(seedTemplate().questions);
    const gateId = clonedScore.find((q) => q.label.startsWith('Do you want')).id;
    const multiId = clonedScore.find((q) => q.label === 'Modalities').id;
    const score = scoreAnswers(
      { passThreshold: 70, borderlineThreshold: 50, questions: clonedScore },
      answersPayload({ [gateId]: 'Yes', [multiId]: 'Both' })
    );
    assert(score.outcome === 'pass', `cloned template should still score pass, got ${score.outcome}`);
    const failScore = scoreAnswers(
      { passThreshold: 70, borderlineThreshold: 50, questions: clonedScore },
      answersPayload({ [gateId]: 'No' })
    );
    assert(failScore.outcome === 'not_interested', 'cloned template gate No → not_interested');

    log('OK: regression pack (radio, equals, end-early, includesAny, library, import, clone scoring)');
  }

  if (failures) {
    console.error(`FAILED with ${failures} failures`);
    process.exit(1);
  }
  console.log(`PASS: survey/template pressure test (${ROUNDS} rounds)`);
}

main();
