/**
 * Opaque invite tokens for site surveys (staff PII).
 * Raw token is shown once at mint; only SHA-256(pepper:raw) is stored.
 */
const crypto = require('crypto');

const DEFAULT_TTL_DAYS = 30;

function pepper() {
    // Prefer a dedicated stable pepper. Do NOT fall back to COSMOS_KEY —
    // rotating the Cosmos key would invalidate every live survey invite.
    return (
        process.env.SURVEY_TOKEN_PEPPER ||
        process.env.PRIVACY_OPS_KEY ||
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

function clampExpiresInDays(days) {
    const n = Number(days);
    if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS;
    return Math.max(1, Math.min(365, Math.round(n)));
}

function defaultExpiresAt(days = DEFAULT_TTL_DAYS) {
    const ttl = clampExpiresInDays(days);
    return new Date(Date.now() + ttl * 24 * 60 * 60 * 1000).toISOString();
}

/** Days after expiresAt we still accept load/save if the link was already opened. */
const EXPIRY_GRACE_DAYS = 7;

function isExpired(iso) {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t < Date.now();
}

function isPastHardExpiry(iso, graceDays = EXPIRY_GRACE_DAYS) {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    return Date.now() > t + graceDays * 24 * 60 * 60 * 1000;
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
    EXPIRY_GRACE_DAYS,
    mintSurveyToken,
    hashSurveyToken,
    clampExpiresInDays,
    defaultExpiresAt,
    isExpired,
    isPastHardExpiry,
    redactAssignment,
    buildInviteUrl,
};
