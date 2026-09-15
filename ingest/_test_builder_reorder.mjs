/**
 * Proof test: builder sync must keep radio/multiselect + options + logic across reorder.
 * Uses linkedom to simulate the admin builder DOM.
 *
 *   node ingest/_test_builder_reorder.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ensureLinkedom() {
  try {
    return require('linkedom');
  } catch (_) {
    execSync('npm install --no-save linkedom@0.16.11', { cwd: REPO, stdio: 'inherit' });
    return require('linkedom');
  }
}

const { parseHTML } = ensureLinkedom();

const SURVEY_QUESTION_TYPES = ['select', 'radio', 'multiselect', 'rating', 'text', 'textarea', 'number', 'date'];

const normalizeSurveyQuestionType = (type) => {
  const t = String(type || 'text').toLowerCase().trim();
  if (t === 'yesno' || t === 'yes/no' || t === 'boolean') return 'radio';
  if (t === 'stars' || t === 'star') return 'rating';
  if (t === 'checkboxes' || t === 'checkbox' || t === 'multi' || t === 'multi-select') return 'multiselect';
  if (SURVEY_QUESTION_TYPES.includes(t)) return t;
  if (t === 'longtext' || t === 'paragraph') return 'textarea';
  if (t === 'shorttext' || t === 'string') return 'text';
  return 'text';
};

const isChoiceQuestionType = (type) => {
  const t = normalizeSurveyQuestionType(type);
  return t === 'select' || t === 'radio' || t === 'multiselect';
};

const coerceOptionList = (raw) => {
  if (raw == null || raw === '') return [];
  if (typeof raw === 'string') return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (typeof o === 'string' || typeof o === 'number') return String(o).trim();
    if (o && typeof o === 'object') return String(o.label ?? o.value ?? '').trim();
    return '';
  }).filter(Boolean);
};

const resolveBuilderOptions = (q) => {
  const type = normalizeSurveyQuestionType(q?.type);
  if (!isChoiceQuestionType(type)) return [];
  let opts = coerceOptionList(q?.options);
  if (!opts.length && (type === 'radio' || type === 'select')) opts = ['Yes', 'No'];
  return opts;
};

function renderCardHtml(q, idx, all) {
  const qType = normalizeSurveyQuestionType(q.type);
  const isSelect = isChoiceQuestionType(qType);
  const opts = isSelect ? resolveBuilderOptions(q) : [];
  const showIfQId = q.logic?.showIf?.questionId || '';
  const showIfEquals = q.logic?.showIf?.equals ?? '';
  const showIfOp = q.logic?.showIf?.notEmpty ? 'notEmpty' : (showIfEquals !== '' || showIfQId ? 'equals' : 'equals');
  const showIfValue = showIfEquals;
  return `
  <div data-q-card="${idx}" data-q-idx="${idx}">
    <input name="q_label_${idx}" value="${q.label || ''}" />
    <input name="q_help_${idx}" value="" />
    <select name="q_type_${idx}">
      ${['select','radio','multiselect','rating','text','textarea','number','date'].map((t) =>
        `<option value="${t}" ${qType === t ? 'selected' : ''}>${t}</option>`).join('')}
    </select>
    <input id="q_required_${idx}" type="checkbox" checked />
    ${isSelect ? `
      <div data-choice-list="${idx}">
        ${opts.map((opt, oi) => `
          <input type="text" data-choice-input="1" name="q_choice_${idx}_${oi}" value="${opt}" />
        `).join('')}
      </div>
      <input type="hidden" name="q_options_${idx}" value="${opts.join('\\n')}" data-options-backup="${idx}" />
    ` : `<input type="hidden" name="q_options_${idx}" value="" />`}
    <input type="checkbox" class="q-score-enable" data-score-for="${idx}" />
    <input name="q_category_${idx}" value="${q.category || 'General'}" />
    <input name="q_scoring_weight_${idx}" type="number" value="0" />
    <details>
      <select name="q_logic_qid_${idx}">
        <option value=""></option>
        ${all.map((qq, qi) => qi === idx ? '' : `<option value="${qq.id}" ${showIfQId === qq.id ? 'selected' : ''}>${qq.label}</option>`).join('')}
      </select>
      <select name="q_logic_op_${idx}">
        <option value="equals" ${showIfOp === 'equals' ? 'selected' : ''}>equals</option>
        <option value="notEmpty" ${showIfOp === 'notEmpty' ? 'selected' : ''}>notEmpty</option>
      </select>
      <input name="q_logic_value_${idx}" value="${showIfValue}" />
    </details>
  </div>`;
}

function buildDom(questions) {
  const html = `<!doctype html><html><body>
    <div id="site-survey-questions-builder">
      ${questions.map((q, i) => renderCardHtml(q, i, questions)).join('')}
    </div>
  </body></html>`;
  const { document } = parseHTML(html);
  return document;
}

// Mirror of hardened sync (must stay aligned with index.html)
function syncBuilderFromDom(document, questions) {
  const root = document.getElementById('site-survey-questions-builder');
  const qs = [...questions];
  qs.forEach((q, idx) => {
    const card = root.querySelector(`[data-q-card="${idx}"]`);
    if (!card) return;
    const prevType = q.type;
    const prevOptions = coerceOptionList(q.options);
    const prevLogic = q.logic && typeof q.logic === 'object' ? q.logic : null;

    q.label = (card.querySelector(`input[name="q_label_${idx}"]`)?.value || '').trim();
    const sel = card.querySelector(`select[name="q_type_${idx}"]`);
    const raw = readSelectValue(sel);
    let next = raw ? normalizeSurveyQuestionType(raw) : normalizeSurveyQuestionType(prevType);
    if (!sel) next = normalizeSurveyQuestionType(prevType);
    if (!raw) next = normalizeSurveyQuestionType(prevType);
    if (!SURVEY_QUESTION_TYPES.includes(String(raw).toLowerCase()) && next === 'text' && normalizeSurveyQuestionType(prevType) !== 'text') {
      next = normalizeSurveyQuestionType(prevType);
    }
    q.type = next;

    const logicQId = readSelectValue(card.querySelector(`select[name="q_logic_qid_${idx}"]`));
    if (logicQId) {
      const logicOp = readSelectValue(card.querySelector(`select[name="q_logic_op_${idx}"]`)) || 'equals';
      const logicValue = (card.querySelector(`input[name="q_logic_value_${idx}"]`)?.value || '').trim();
      const showIf = { questionId: logicQId };
      if (logicOp === 'notEmpty') showIf.notEmpty = true;
      else showIf.equals = logicValue;
      q.logic = { showIf };
    } else if (prevLogic && !card.querySelector(`select[name="q_logic_qid_${idx}"]`)) {
      q.logic = prevLogic;
    } else {
      q.logic = null;
    }

    if (isChoiceQuestionType(q.type)) {
      const list = card.querySelector(`[data-choice-list="${idx}"]`);
      const choiceInputs = list
        ? [...list.querySelectorAll('input[data-choice-input="1"], input[name^="q_choice_"]')]
        : [];
      // OLD BUG repro: vacuuming every input[type=text] in the card would steal label etc.
      const buggy = [...card.querySelectorAll('input[type="text"]')].map((i) => i.value.trim()).filter(Boolean);
      const fromDom = choiceInputs.map((inp) => String(inp.value || '').trim()).filter(Boolean);
      let opts = fromDom.length ? fromDom : prevOptions;
      if (!opts.length && prevOptions.length) opts = prevOptions;
      q.options = resolveBuilderOptions({ ...q, options: opts });
      q._buggyWouldHaveBeen = buggy;
    } else {
      q.options = [];
    }
  });
  return qs;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function readSelectValue(sel) {
  if (!sel) return '';
  const selected = sel.querySelector('option[selected]');
  if (selected) return String(selected.value || '').trim();
  try {
    if (typeof sel.value === 'string' && sel.value) return String(sel.value).trim();
  } catch (_) {}
  const first = sel.querySelector('option');
  return first ? String(first.value || '').trim() : '';
}

function main() {
  let questions = [
    {
      id: 'q_a',
      label: 'Interested?',
      type: 'radio',
      options: ['Yes', 'No'],
      logic: null,
      category: 'General',
    },
    {
      id: 'q_b',
      label: 'Why not?',
      type: 'multiselect',
      options: ['No patients', 'Staffing', 'Other'],
      logic: { showIf: { questionId: 'q_a', equals: 'No' } },
      category: 'General',
    },
    {
      id: 'q_c',
      label: 'PI name',
      type: 'text',
      options: [],
      logic: null,
      category: 'General',
    },
  ];

  // Render → sync → reorder up (move q_b before q_a) → re-render → sync again
  for (let round = 0; round < 5; round++) {
    let document = buildDom(questions);
    questions = syncBuilderFromDom(document, questions);

    const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
    assert(byId.q_a.type === 'radio', `round ${round}: radio demoted to ${byId.q_a.type}`);
    assert(byId.q_b.type === 'multiselect', `round ${round}: multiselect demoted to ${byId.q_b.type}`);
    assert(byId.q_a.options.length === 2, `round ${round}: radio options lost ${JSON.stringify(byId.q_a.options)}`);
    assert(byId.q_b.options.length === 3, `round ${round}: multi options lost ${JSON.stringify(byId.q_b.options)}`);
    assert(byId.q_b.logic?.showIf?.questionId === 'q_a', `round ${round}: logic lost`);
    assert(byId.q_b.logic?.showIf?.equals === 'No', `round ${round}: logic value lost`);

    // Simulate move up on whatever index currently holds q_b (if not already 0)
    const idx = questions.findIndex((q) => q.id === 'q_b');
    if (idx > 0) {
      const qs = questions;
      [qs[idx - 1], qs[idx]] = [qs[idx], qs[idx - 1]];
      questions = qs;
    } else if (idx === 0 && questions.length > 1) {
      // move down instead to keep exercising swaps
      const qs = questions;
      [qs[0], qs[1]] = [qs[1], qs[0]];
      questions = qs;
    }

    document = buildDom(questions);
    questions = syncBuilderFromDom(document, questions);

    const after = Object.fromEntries(questions.map((q) => [q.id, q]));
    assert(after.q_b.type === 'multiselect', `round ${round} after move: multiselect demoted to ${after.q_b.type}`);
    assert(after.q_a.type === 'radio', `round ${round} after move: radio demoted to ${after.q_a.type}`);
    assert(after.q_b.options.length === 3, `round ${round} after move: multiselect options=${JSON.stringify(after.q_b.options)}`);
    assert(after.q_a.options.length === 2, `round ${round} after move: radio options=${JSON.stringify(after.q_a.options)}`);
    assert(after.q_b.logic?.showIf?.questionId === 'q_a', `round ${round} after move: logic broken`);
  }

  // Edit logic in DOM then sync without re-render wipe
  let document = buildDom(questions);
  const card0 = document.querySelector('[data-q-card="0"]');
  // whichever is index 0, set logic pointing at q_c if present
  const logicSel = card0.querySelector('select[name="q_logic_qid_0"]');
  const textQ = questions.find((q) => q.id === 'q_c');
  if (logicSel && textQ) {
    // linkedom: mark selected via attribute
    [...logicSel.querySelectorAll('option')].forEach((o) => o.removeAttribute('selected'));
    const opt = [...logicSel.querySelectorAll('option')].find((o) => o.value === textQ.id);
    if (opt) opt.setAttribute('selected', '');
    const opSel = card0.querySelector('select[name="q_logic_op_0"]');
    [...opSel.querySelectorAll('option')].forEach((o) => o.removeAttribute('selected'));
    const eq = [...opSel.querySelectorAll('option')].find((o) => o.value === 'equals');
    if (eq) eq.setAttribute('selected', '');
    card0.querySelector('input[name="q_logic_value_0"]').setAttribute('value', 'hello');
    // linkedom input .value may also be getter-only depending on version
    try { card0.querySelector('input[name="q_logic_value_0"]').value = 'hello'; } catch (_) {}
    questions = syncBuilderFromDom(document, questions);
    assert(questions[0].logic?.showIf?.questionId === textQ.id, 'DOM logic edit not synced');
    assert(questions[0].logic?.showIf?.equals === 'hello', 'DOM logic value not synced');
  }

  // Hardened choice selector must only see choice rows, not labels
  document = buildDom([
    { id: 'q1', label: 'Long label text that is not an option', type: 'radio', options: ['Yes', 'No'], logic: null },
  ]);
  const card = document.querySelector('[data-q-card="0"]');
  const labelVal = card.querySelector('input[name="q_label_0"]')?.value;
  assert(labelVal === 'Long label text that is not an option', 'setup: label missing');
  const safe = [...card.querySelectorAll('[data-choice-list="0"] input[data-choice-input="1"], [data-choice-list="0"] input[name^="q_choice_"]')]
    .map((i) => i.value);
  assert(!safe.includes('Long label text that is not an option'), 'hardened selector leaked label into options');
  assert(safe.includes('Yes') && safe.includes('No'), 'hardened selector missed choices');

  // Old overly-broad selector inside the whole card WOULD include non-choice text-like fields if they had type=text
  card.querySelector('input[name="q_label_0"]').setAttribute('type', 'text');
  const broad = [...card.querySelectorAll('input[type="text"]')].map((i) => i.value);
  assert(broad.includes('Long label text that is not an option'), 'setup: broad selector sees label when type=text');
  assert(!safe.includes('Long label text that is not an option'), 'safe selector still excludes label');

  console.log('PASS — 5 reorder rounds kept radio/multiselect/options/logic; DOM logic sync OK');
}

main();
