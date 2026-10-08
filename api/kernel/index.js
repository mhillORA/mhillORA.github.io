/**
 * CHAOS platform kernel — identity, authz, audit.
 * Containers (users, crcs, events, …) remain the object stores;
 * these modules enforce cross-object rules with zero downtime (additive).
 */

const identity = require('./identity');
const authz = require('./authz');
const audit = require('./audit');

module.exports = {
    ...identity,
    ...authz,
    ...audit,
};
