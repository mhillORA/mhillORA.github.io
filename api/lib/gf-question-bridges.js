/**
 * Old GF / Monday / SurveyMonkey answer ids & labels → libraryQuestionId
 * for the Sep 2026 Long form. Map-only — never edits the survey definition.
 */
const GF_OLD_QID_TO_LIB = {
    // Live / prior GF long ids
    'gf_00_name': 'ql-gf-00-name',
    'gf_01_date-of-response': 'ql-gf-01-date-of-response',
    'gf_02_site-name': 'ql-site-name',
    'gf_03_address': 'ql-site-address',
    'gf_04_phone': 'ql-site-phone',
    'gf_05_practice-setting': 'ql-gf-05-practice-setting',
    'gf_06_investigators': 'ql-gf-06-investigators',
    'gf_07_investigator-1': 'ql-pi-name',
    'gf_08_inv-1-credentials': 'ql-gf-08-inv-1-credentials',
    'gf_09_inv-1-email': 'ql-pi-email',
    'gf_10_inv-1-specialties': 'ql-gf-10-inv-1-specialties',
    'gf_11_experience-yrs': 'ql-gf-11-experience-yrs',
    'gf_12_investigator-2': 'ql-gf-12-investigator-2',
    'gf_13_inv-2-credentials': 'ql-gf-13-inv-2-credentials',
    'gf_14_inv-2-specialities': 'ql-gf-14-inv-2-specialities',
    'gf_15_research-contact': 'ql-coord-name',
    'gf_16_poc-email': 'ql-coord-email',
    'gf_17_poc-role': 'ql-primary-contact-role',
    'gf_18_site-coordinators': 'ql-gf-18-site-coordinators',
    'gf_19_research-experience': 'ql-gf-19-research-experience',
    'gf_20_please-indicate-the-types-of-ophthalmic-studies-your-sit': 'ql-gf-20-please-indicate-the-types-of-ophthalmic-studies-your-sit',
    'gf_21_sponsor-experience': 'ql-gf-21-sponsor-experience',
    'gf_22_other-committees': 'ql-gf-22-other-committees',
    'gf_23_patient-identification': 'ql-gf-23-patient-identification',
    'gf_24_translations': 'ql-gf-24-translations',
    'gf_25_equipment': 'ql-gf-25-equipment',
    'gf_26_past-fda-audits': 'ql-gf-26-past-fda-audits',
    'gf_27_483': 'ql-gf-27-483',
    'gf_28_483-year': 'ql-gf-28-483-year',
    'gf_29_central-irb': 'ql-gf-29-central-irb',
    'gf_30_contracting-contact': 'ql-contracts-name',
    'gf_31_trials-last-12-mo': 'ql-gf-31-trials-last-12-mo',
    'gf_32_enrolled-last-12-mo': 'ql-gf-32-enrolled-last-12-mo',
    'gf_33_trials-5-yrs': 'ql-gf-33-trials-5-yrs',
    'gf_34_enrolled-5-yrs': 'ql-gf-34-enrolled-5-yrs',
    'gf_35_ded-database': 'ql-gf-35-ded-database',
    'gf_36_allergy-database': 'ql-gf-36-allergy-database',
    // Monday.com General Site Feasibility (master ingest)
    'q_000_date-of-response': 'ql-gf-01-date-of-response',
    'q_001_site-name': 'ql-site-name',
    'q_002_address': 'ql-site-address',
    'q_003_phone': 'ql-site-phone',
    'q_004_practice-setting': 'ql-gf-05-practice-setting',
    'q_005_investigators': 'ql-gf-06-investigators',
    'q_006_investigator-1': 'ql-pi-name',
    'q_007_inv-1-credentials': 'ql-gf-08-inv-1-credentials',
    'q_008_research-contact': 'ql-coord-name',
    'q_009_poc-email': 'ql-coord-email',
    'q_010_inv-1-email': 'ql-pi-email',
    'q_011_inv-1-specialties': 'ql-gf-10-inv-1-specialties',
    'q_012_experience-yrs': 'ql-gf-11-experience-yrs',
    'q_013_poc-role': 'ql-primary-contact-role',
    'q_014_research-experience': 'ql-gf-19-research-experience',
    'q_015_please-indicate-the-types-of-ophthalmic-': 'ql-gf-20-please-indicate-the-types-of-ophthalmic-studies-your-sit',
    'q_016_sponsor-experience': 'ql-gf-21-sponsor-experience',
    'q_017_other-committees': 'ql-gf-22-other-committees',
    'q_018_patient-identification': 'ql-gf-23-patient-identification',
    'q_019_translations': 'ql-gf-24-translations',
    'q_020_equipment': 'ql-gf-25-equipment',
    'q_021_past-fda-audits': 'ql-gf-26-past-fda-audits',
    'q_022_483': 'ql-gf-27-483',
    'q_023_central-irb': 'ql-gf-29-central-irb',
    'q_024_contracting-contact': 'ql-contracts-name',
    'q_025_trials-last-12-mo': 'ql-gf-31-trials-last-12-mo',
    'q_026_enrolled-last-12-mo': 'ql-gf-32-enrolled-last-12-mo',
    'q_027_trials-5-yrs': 'ql-gf-33-trials-5-yrs',
    'q_028_enrolled-5-yrs': 'ql-gf-34-enrolled-5-yrs',
    'q_029_ded-database': 'ql-gf-35-ded-database',
    'q_030_allergy-database': 'ql-gf-36-allergy-database',
    'q_031_investigator-2': 'ql-gf-12-investigator-2',
    'q_032_inv-2-credentials': 'ql-gf-13-inv-2-credentials',
    'q_033_inv-2-specialities': 'ql-gf-14-inv-2-specialities',
    'q_034_site-coordinators': 'ql-gf-18-site-coordinators',
    'q_035_483-year': 'ql-gf-28-483-year',
};

const GF_OLD_LABEL_TO_LIB = {
    'name': 'ql-gf-00-name',
    'date of response': 'ql-gf-01-date-of-response',
    'site name': 'ql-site-name',
    'site legal name': 'ql-site-name',
    'address': 'ql-site-address',
    'phone': 'ql-site-phone',
    'practice setting': 'ql-gf-05-practice-setting',
    '# investigators': 'ql-gf-06-investigators',
    'investigator #1': 'ql-pi-name',
    'inv #1 credentials': 'ql-gf-08-inv-1-credentials',
    'inv #1 email': 'ql-pi-email',
    'inv #1 specialties': 'ql-gf-10-inv-1-specialties',
    'experience (yrs)': 'ql-gf-11-experience-yrs',
    'investigator #2': 'ql-gf-12-investigator-2',
    'inv #2 credentials': 'ql-gf-13-inv-2-credentials',
    'inv #2 specialities': 'ql-gf-14-inv-2-specialities',
    'research contact': 'ql-coord-name',
    'poc email': 'ql-coord-email',
    'poc role': 'ql-primary-contact-role',
    'site coordinators': 'ql-gf-18-site-coordinators',
    'research experience': 'ql-gf-19-research-experience',
    'sponsor experience': 'ql-gf-21-sponsor-experience',
    'other committees': 'ql-gf-22-other-committees',
    'patient identification': 'ql-gf-23-patient-identification',
    'translations': 'ql-gf-24-translations',
    'equipment': 'ql-gf-25-equipment',
    'past fda audits': 'ql-gf-26-past-fda-audits',
    '483?': 'ql-gf-27-483',
    '483': 'ql-gf-27-483',
    '483 year': 'ql-gf-28-483-year',
    'central irb?': 'ql-gf-29-central-irb',
    'central irb': 'ql-gf-29-central-irb',
    'contracting contact': 'ql-contracts-name',
    'trials (last 12 mo)': 'ql-gf-31-trials-last-12-mo',
    'enrolled (last 12 mo)': 'ql-gf-32-enrolled-last-12-mo',
    'trials (5 yrs)': 'ql-gf-33-trials-5-yrs',
    'enrolled (5 yrs)': 'ql-gf-34-enrolled-5-yrs',
    'ded database': 'ql-gf-35-ded-database',
    'allergy database': 'ql-gf-36-allergy-database',
};

/**
 * Only genuine concept overlaps onto an existing bible field.
 * A Form 483 is issued after a regulatory inspection → implies "ever audited" = Yes.
 * Do NOT map trials counts, DED/allergy DB sizes, specialties, coordinator headcount,
 * patient-ID methods, etc. — those are different questions with no home on Long.
 */
const GF_LIB_FALLBACK_TO_BIBLE = {
    'ql-gf-27-483': 'ql-gf-26-past-fda-audits',
    'ql-gf-28-483-year': 'ql-gf-26-past-fda-audits',
};

/**
 * Monday / SurveyMonkey / ephemeral libraryQuestionIds → shared canonical ids.
 * Applied even when the answer already has a libraryQuestionId set (critical for
 * Cavalry ↔ Viatris exact-wording matches that used different auto-generated libs).
 */
const ALIAS_LIB_TO_CANON = {
    // --- Viatris NK admin / identity (exact wording vs Cavalry) ---
    mu0gw9orfunfqyleef8: 'ql-gf-01-date-of-response', // Date
    mu0gw9vo0o6xrvosd80l: 'ql-gf-00-name', // First & Last Name of Respondent
    mu0gwa0cuun9ee5icql: 'ql-form-filler-phone', // Phone Number of Respondent
    mu0guch5bdg27ycuq4b: 'ql-form-filler-role', // Title/Position of Respondent
    mu0gwa5weiuuti4877t: 'ql-form-filler-email', // Email Address of Respondent
    mu0gu9w0zymitcvs22q: 'ql-site-name',
    mu0gwaebizei5rwir4: 'ql-site-phone',
    mu0gwajryxwzn8m679: 'ql-pi-name',
    mu0gwanjb5ikjnnf3c: 'ql-pi-email',
    mu0gucycg5k7t2uspo7: 'ql-pi-credentials',
    mu0gwarkbuv6jfvqobp: 'ql-pi-specialty',
    mu0gwavqvi7hasnvu4h: 'ql-coord-name',
    mu0gud9kauwt1gyyhiw: 'ql-coord-email',
    mu0gwb8opdil52l29bk: 'ql-coord-phone',
    // --- Viatris NK equipment / assessments (near or exact vs Cavalry) ---
    mu0gwdeg5bhhifg002w: 'ql-schirmer-tear-samples', // Schirmer tear strips
    mu0gwdi9qs6674tix9o: 'ql-capillary-tear-samples', // capillary tube
    mu0gwe41qnlmt48u0cj: 'ql-mackie-criteria-nk', // Mackie Criteria
    mu0gwecdqd48s87a3uj: 'ql-cochet-bonnet-esthesiometer', // Cochet-Bonnet Yes/No
    mu0gwei63fqpp8ni3xw: 'ql-slit-lamp-camera', // slit-lamp camera Yes/No
    mu0gwelz2v6byi4f6ya: 'ql-slit-lamp-camera-model', // make/model
    mu0gwd9yonjtyfl5k1: 'ql-phlebotomist-lab-samples',
    // --- Cavalry ephemeral / study-local libs → same shared canon ---
    mv18s0px3f4048jf944: 'ql-gf-01-date-of-response',
    mv18s0u9s7bxfzrpcvo: 'ql-gf-00-name',
    mv18s0zu3xz9mzeaumy: 'ql-form-filler-phone',
    mv18s4ccdoj74hdz29: 'ql-form-filler-role',
    mv18s4llvgh0fnl9b59: 'ql-form-filler-email',
    mv18s5pl0rzv0opxgvp: 'ql-pi-credentials',
    mv18s5uw50b03ksbnde: 'ql-pi-specialty',
    mv18s6swdzfcjih81zo: 'ql-slit-lamp-camera',
    'ql-cav_stu-3_has-your-site-collected-tear-samples-using-schir': 'ql-schirmer-tear-samples',
    'ql-cav_stu-2_are-your-pi-and-or-sub-investigators-familiar-wi': 'ql-mackie-criteria-nk',
    'ql-cav_stu-4a_the-protocol-requires-corneal-sensitivity-to-be-': 'ql-cochet-bonnet-esthesiometer',
    'ql-cav_lab-1a_does-your-site-have-a-certified-phlebotomist-or-': 'ql-phlebotomist-lab-samples',
};

/** Stronger label normalize for cross-survey matching (hyphens / apostrophes). */
function normalizeBridgeLabel(label) {
    return String(label || '')
        .trim()
        .toLowerCase()
        .replace(/[\u2018\u2019\u201c\u201d`]/g, "'")
        .replace(/schirmer['']?s/g, 'schirmers')
        .replace(/aesthesiometer/g, 'esthesiometer')
        .replace(/slit-lamp/g, 'slit lamp')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Concept fingerprints for near-equivalent wording (Schirmer / Mackie / slit lamp…).
 * Only fires when the label clearly names the same assessment.
 */
function resolveConceptLibraryId(label) {
    const n = normalizeBridgeLabel(label);
    if (!n) return '';
    if (n.includes('schirmer') && n.includes('tear')) return 'ql-schirmer-tear-samples';
    if (n.includes('capillary') && n.includes('tear')) return 'ql-capillary-tear-samples';
    if (n.includes('mackie') && (n.includes('keratitis') || n.includes('keratopathy') || n.includes('criteria'))) {
        return 'ql-mackie-criteria-nk';
    }
    // Cochet-Bonnet / corneal esthesiometer Yes-No (not filament follow-ups)
    if (!n.includes('filament') && !n.includes('replacement') && !n.includes('order more')) {
        const cochetDevice = n.includes('cochet') && n.includes('bonnet');
        const esthesioDevice = (n.includes('esthesiometer') || n.includes('asthesiometer'))
            && (n.includes('corneal') || n.includes('sensation') || n.includes('sensitivity'));
        if ((cochetDevice || esthesioDevice)
            && (n.includes('have') || n.includes('does your site') || n.includes('measure corneal'))) {
            return 'ql-cochet-bonnet-esthesiometer';
        }
    }
    if (n.includes('as oct') && n.includes('make') && n.includes('model')) {
        return 'ql-as-oct-make-model';
    }
    if (n.includes('slit lamp') && n.includes('make') && n.includes('model')) {
        return 'ql-slit-lamp-camera-model';
    }
    if (n.includes('slit lamp camera') && (n.startsWith('does your site have') || n.includes('have a slit'))) {
        return 'ql-slit-lamp-camera';
    }
    if (n.includes('phlebotomist') && n.includes('lab sample')) return 'ql-phlebotomist-lab-samples';
    if (n === 'site name' || n === 'site legal name' || n === 'institution name') return 'ql-site-name';
    if (n === 'site phone number' || n === 'site phone') return 'ql-site-phone';
    if (n.includes('principal investigator') && n.includes('first') && n.includes('last')) return 'ql-pi-name';
    if (n === 'pi phone number' || n === 'pi phone') return 'ql-pi-phone';
    if (n === 'pi email address' || n === 'pi email') return 'ql-pi-email';
    if (n === 'pi credentials') return 'ql-pi-credentials';
    if (n === 'pi specialty focus' || n.startsWith('pi specialty')) return 'ql-pi-specialty';
    if (n.includes('site coordinator') && n.includes('first') && n.includes('last')) return 'ql-coord-name';
    if (n.includes('site coordinator') && n.includes('email')) return 'ql-coord-email';
    if (n.includes('site coordinator') && n.includes('phone')) return 'ql-coord-phone';
    if (n === 'first last name of respondent' || n === 'first and last name of respondent') return 'ql-gf-00-name';
    if (n === 'email address of respondent') return 'ql-form-filler-email';
    if (n.startsWith('phone number of respondent')) return 'ql-form-filler-phone';
    if (n === 'title position of respondent' || n === 'title / position of respondent') return 'ql-form-filler-role';
    return '';
}

function canonicalizeLibraryId(libId) {
    const lib = String(libId || '');
    if (!lib) return '';
    return ALIAS_LIB_TO_CANON[lib] || lib;
}

function resolveSourceLibraryId(a) {
    const qid = String(a?.questionId ?? a?.id ?? '');
    const rawLib = String(a?.libraryQuestionId || '');
    if (rawLib) {
        const canon = canonicalizeLibraryId(rawLib);
        if (canon) return canon;
    }
    if (qid && GF_OLD_QID_TO_LIB[qid]) return GF_OLD_QID_TO_LIB[qid];
    if (qid && ALIAS_LIB_TO_CANON[qid]) return ALIAS_LIB_TO_CANON[qid];
    if (qid.startsWith('q_015_please-indicate-the-types-of-ophthalmic')) {
        return 'ql-gf-20-please-indicate-the-types-of-ophthalmic-studies-your-sit';
    }
    const labRaw = String(a?.label || a?.title || '');
    const lab = labRaw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (lab && GF_OLD_LABEL_TO_LIB[lab]) return GF_OLD_LABEL_TO_LIB[lab];
    if (lab.startsWith('please indicate the types of ophthalmic studies')) {
        return 'ql-gf-20-please-indicate-the-types-of-ophthalmic-studies-your-sit';
    }
    const byConcept = resolveConceptLibraryId(labRaw);
    if (byConcept) return byConcept;
    return '';
}

function applyBibleFallback(libId) {
    const lib = String(libId || '');
    if (!lib) return '';
    const canon = canonicalizeLibraryId(lib);
    return GF_LIB_FALLBACK_TO_BIBLE[canon] || canon;
}

function resolveGfBridgeLibraryId(a) {
    return applyBibleFallback(resolveSourceLibraryId(a));
}

/**
 * Shape values when routing 483 answers onto the audits question.
 * Returns { libraryQuestionId, value } or null to skip (do not invent a mismatch).
 */
function reshapeBridgeAnswer(resolvedLib, rawValue, sourceLib) {
    const val = String(rawValue ?? '').trim();
    if (!val) return null;
    const src = String(sourceLib || '');
    const dest = String(resolvedLib || '');
    if (!dest) return null;

    if (dest === 'ql-gf-26-past-fda-audits') {
        // 483 year implies an inspection occurred
        if (src.includes('483-year') || src.includes('gf-28')) {
            return { libraryQuestionId: dest, value: `Yes (483 year: ${val})` };
        }
        // 483 Yes ⇒ audited Yes; 483 No does NOT mean never audited — skip
        if (src.includes('483') || src.includes('gf-27')) {
            if (/^yes$/i.test(val)) return { libraryQuestionId: dest, value: 'Yes' };
            return null;
        }
    }

    return { libraryQuestionId: dest, value: val };
}

module.exports = {
    GF_OLD_QID_TO_LIB,
    GF_OLD_LABEL_TO_LIB,
    GF_LIB_FALLBACK_TO_BIBLE,
    ALIAS_LIB_TO_CANON,
    normalizeBridgeLabel,
    resolveConceptLibraryId,
    canonicalizeLibraryId,
    resolveSourceLibraryId,
    resolveGfBridgeLibraryId,
    applyBibleFallback,
    reshapeBridgeAnswer,
};
