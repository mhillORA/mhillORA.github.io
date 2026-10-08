/**
 * CHAOS kernel — capability checks (server authority).
 * UI may hide controls; only these checks authorize writes.
 * Single-tenant ORA — no org scoping required.
 */

const CAPABILITIES = {
    Manager: ['*'],
    Admin: ['*'],
    Supervisor: [
        'schedule.read',
        'schedule.write',
        'pto.approve',
        'staff.read',
        'staff.write',
        'travel.read',
        'travel.write',
        'users.read',
    ],
    CRC: [
        'schedule.read.self',
        'pto.request',
        'travel.read.self',
    ],
    User: ['schedule.read.self'],
};

const hasCapability = (permissionLevel, capability) => {
    const level = permissionLevel || 'CRC';
    const caps = CAPABILITIES[level] || CAPABILITIES.CRC;
    if (caps.includes('*')) return true;
    return caps.includes(capability);
};

const requireCapability = (user, capability) => {
    const level = (user && user.permissionLevel) || 'CRC';
    if (!hasCapability(level, capability)) {
        const err = new Error(`FORBIDDEN: '${capability}' not allowed for ${level}`);
        err.code = 'FORBIDDEN';
        err.status = 403;
        throw err;
    }
    return true;
};

module.exports = {
    CAPABILITIES,
    hasCapability,
    requireCapability,
};
