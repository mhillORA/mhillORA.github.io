/**
 * CHAOS kernel — append-only audit log (fire-and-forget).
 * Never blocks the request path. Soft-delete / restore can replay `before`.
 */

const createAuditWriter = ({ ensureContainer, getContainer, generateId }) => {
    let ready = null;

    const ensure = async () => {
        if (ready) return ready;
        ready = Promise.resolve()
            .then(() => ensureContainer())
            .catch((err) => {
                ready = null;
                throw err;
            });
        return ready;
    };

    const writeAuditAsync = (entry = {}) => {
        Promise.resolve()
            .then(async () => {
                await ensure();
                const item = {
                    id: entry.id || (typeof generateId === 'function' ? generateId() : `audit-${Date.now()}`),
                    org: 'ORA',
                    at: entry.at || new Date().toISOString(),
                    action: entry.action || 'unknown',
                    entityType: entry.entityType || null,
                    entityId: entry.entityId || null,
                    actorUserId: entry.actorUserId || null,
                    actorUsername: entry.actorUsername || null,
                    permissionLevel: entry.permissionLevel || null,
                    before: entry.before != null ? entry.before : null,
                    after: entry.after != null ? entry.after : null,
                    meta: entry.meta || null,
                    requestId: entry.requestId || null,
                };
                await getContainer().items.create(item);
            })
            .catch((err) => {
                console.warn(`writeAuditAsync failed: ${err && err.message ? err.message : err}`);
            });
    };

    return { writeAuditAsync };
};

const actorFromRequest = (request) => {
    const h = request && request.headers;
    const get = (name) => {
        if (!h) return '';
        if (typeof h.get === 'function') return h.get(name) || h.get(name.toLowerCase()) || '';
        return h[name] || h[name.toLowerCase()] || '';
    };
    return {
        actorUserId: String(get('x-user-id') || get('user-id') || '').slice(0, 120),
        actorUsername: String(get('x-username') || get('username') || '').slice(0, 120),
        permissionLevel: String(get('x-user-permission') || get('user-permission') || '').slice(0, 40),
    };
};

/** Compact shift snapshot for audit before/after (keeps docs small). */
const snapshotEvent = (resource) => {
    if (!resource || typeof resource !== 'object') return null;
    return {
        id: resource.id || null,
        type: resource.type || null,
        date: resource.date || resource.startDate || null,
        endDate: resource.endDate || null,
        siteId: resource.siteId || null,
        studyIds: Array.isArray(resource.studyIds) ? resource.studyIds.slice(0, 12) : [],
        groupId: resource.groupId || null,
        visitNumber: resource.visitNumber || null,
        groupNumber: resource.groupNumber || null,
        period: resource.period || null,
        crcId: resource.crcId || null,
        crcIds: Array.isArray(resource.crcIds) ? resource.crcIds.slice(0, 20) : [],
        roleKeys: resource.roleAssignments && typeof resource.roleAssignments === 'object'
            ? Object.keys(resource.roleAssignments).slice(0, 20)
            : [],
        cancelled: !!(resource.cancelled || resource.isCancelled),
        deletedAt: resource.deletedAt || null,
    };
};

module.exports = {
    createAuditWriter,
    actorFromRequest,
    snapshotEvent,
};
