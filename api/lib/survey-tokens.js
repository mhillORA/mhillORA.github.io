/**
 * Opaque invite tokens for site surveys (staff PII).
 * Raw token is shown once at mint; only SHA-256(pepper:raw) is stored.
 */
const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 30;

function pepper() {
    return (
        process.env.SURVEY_TOKEN_PEPPER ||
        process.env.PRIVACY_OPS_KEY ||
        process.env.COSMOS_KEY ||
        'artemis-dev-survey-pepper'
    );
}

function mintSurveyToken() {
    const raw = crypto.randomBytes(32).toString('base64url');
    return {
        raw,
        hash: hashSurveyToken(raw),
        prefix: raw.slice(0, 8),
    };
}

function hashSurveyToken(raw) {
    return crypto.createHash('sha256').update(`${pepper()}:${String(raw || '')}`).digest('hex');
}

function defaultExpiresAt(days = DEFAULT_TTL_DAYS) {
    const n = Number(days);
    const ttl = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
    return new Date(Date.now() + ttl * 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(iso) {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t < Date.now();
}

/** Strip secrets before returning assignment docs to any client. */
function redactAssignment(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const {
        tokenHash,
        tokenRaw,
        inviteToken,
        ...safe
    } = doc;
    return {
        ...safe,
        hasInviteToken: Boolean(tokenHash),
        tokenPrefix: doc.tokenPrefix || undefined,
    };
}

function buildInviteUrl(baseUrl, rawToken) {
    const base = String(baseUrl || '').replace(/\/$/, '');
    return `${base}/site-survey.html?t=${encodeURIComponent(rawToken)}`;
}

module.exports = {
    DEFAULT_TTL_DAYS,
    mintSurveyToken,
    hashSurveyToken,
    defaultExpiresAt,
    isExpired,
    redactAssignment,
    buildInviteUrl,
};
