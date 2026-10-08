/**
 * CHAOS kernel — login / staff identity helpers.
 * Staff (crcs) and Users stay separate; this picks the right login row
 * when duplicates share a username/email (Marin-class failures).
 */

const PERM_RANK = { Manager: 3, Admin: 3, Supervisor: 2, CRC: 1, User: 0 };

const normalizeIdentity = (value) => String(value || '').trim().toLowerCase();

const isUserActive = (user) => {
    if (!user) return false;
    if (user.active === undefined || user.active === null) return true;
    return user.active !== false;
};

const scoreLoginCandidate = (user) => {
    if (!user) return -Infinity;
    let score = 0;
    if (isUserActive(user)) score += 1000;
    if (user.password) score += 100;
    if (user.entraId) score += 80;
    score += (PERM_RANK[user.permissionLevel] || 0) * 10;
    if (user.crcId) score += 3;
    const created = Date.parse(user.createdAt || '') || Number.MAX_SAFE_INTEGER;
    // Prefer older account when scores tie (stable keeper)
    score -= created / 1e15;
    return score;
};

const pickLoginUser = (candidates) => {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    return [...candidates].sort((a, b) => scoreLoginCandidate(b) - scoreLoginCandidate(a))[0];
};

/**
 * Among rows matching the login name, keep only those whose password verifies,
 * then prefer an active account (avoids passwordless ghosts winning users[0]).
 */
const pickLoginUserWithPassword = (candidates, password, verifyPasswordFn) => {
    const matches = (candidates || []).filter(
        (u) => u && u.password && typeof verifyPasswordFn === 'function' && verifyPasswordFn(password, u.password)
    );
    if (matches.length === 0) return null;
    const active = matches.filter(isUserActive);
    return pickLoginUser(active.length ? active : matches);
};

module.exports = {
    PERM_RANK,
    normalizeIdentity,
    isUserActive,
    scoreLoginCandidate,
    pickLoginUser,
    pickLoginUserWithPassword,
};
