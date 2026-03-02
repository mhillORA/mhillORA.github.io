/**
 * RMT (Retina Mobility Testing) API – completely separate from CHAOS.
 * Own Cosmos client, auth, and endpoints. No shared code with api/index.js.
 * Containers: retina_staff, retina_assignments, retina_timeoff.
 */
const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_ITERATIONS = 100000;
const PASSWORD_KEYLEN = 64;

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function hashPassword(plain) {
    if (!plain || typeof plain !== 'string') return undefined;
    const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
    const hash = crypto.pbkdf2Sync(plain, salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, 'sha512');
    return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(plain, stored) {
    if (!plain || !stored || typeof stored !== 'string') return false;
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const hash = crypto.pbkdf2Sync(plain, salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, 'sha512');
    return hash.toString('hex') === hashHex;
}

function sanitizeRetinaStaff(item) {
    if (!item) return item;
    const { passwordHash, password, ...rest } = item;
    return rest;
}

let cosmosClient = null;
let database = null;

function getCosmosClient() {
    if (!cosmosClient) {
        const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
        const COSMOS_KEY = process.env.COSMOS_KEY;
        const DATABASE_ID = process.env.DATABASE_ID;
        if (!COSMOS_ENDPOINT || !COSMOS_KEY || !DATABASE_ID) {
            throw new Error("COSMOS_DB_CONFIG_MISSING: Missing Cosmos DB env (COSMOS_ENDPOINT, COSMOS_KEY, DATABASE_ID).");
        }
        cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
        database = cosmosClient.database(DATABASE_ID);
    }
    return { client: cosmosClient, database };
}

function getContainer(name) {
    const { database } = getCosmosClient();
    return database.container(name);
}

function handleError(context, error, message) {
    context.log.error(`${message}:`, error.message);
    const errMsg = error.message.includes('COSMOS_DB_CONFIG_MISSING')
        ? "API Configuration Error: Database not configured."
        : error.message.includes('VALIDATION_ERROR')
            ? error.message.replace('VALIDATION_ERROR: ', '')
            : "Internal Server Error.";
    return {
        status: 500,
        jsonBody: { error: errMsg },
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    };
}

const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// --- Validators (RMT only) ---
function validateRetinaStaffSchema(data) {
    const errors = [];
    if (!data.name || typeof data.name !== 'string') errors.push('name is required (string)');
    if (!data.email || typeof data.email !== 'string') errors.push('email is required (string, used as username)');
    if (data.password !== undefined && data.password !== null && typeof data.password !== 'string') errors.push('password must be a string');
    if (errors.length) throw new Error(`VALIDATION_ERROR: Retina staff: ${errors.join(', ')}`);
}

function validateRetinaAssignmentsSchema(data) {
    const errors = [];
    if (!data.staffId || typeof data.staffId !== 'string') errors.push('staffId required');
    if (!data.date || typeof data.date !== 'string') errors.push('date required (YYYY-MM-DD)');
    if (!data.startTime || typeof data.startTime !== 'string') errors.push('startTime required');
    if (!data.endTime || typeof data.endTime !== 'string') errors.push('endTime required');
    if (!data.location || typeof data.location !== 'string') errors.push('location required');
    if (errors.length) throw new Error(`VALIDATION_ERROR: Retina assignment: ${errors.join(', ')}`);
}

function validateRetinaTimeOffSchema(data) {
    const errors = [];
    if (!data.staffId || typeof data.staffId !== 'string') errors.push('staffId required');
    if (!data.startDate || typeof data.startDate !== 'string') errors.push('startDate required');
    if (!data.endDate || typeof data.endDate !== 'string') errors.push('endDate required');
    if (!data.status || !['pending', 'approved', 'denied'].includes(data.status)) errors.push('status must be pending|approved|denied');
    if (data.type !== undefined && data.type !== null && typeof data.type !== 'string') errors.push('type must be string');
    if (data.notes !== undefined && data.notes !== null && typeof data.notes !== 'string') errors.push('notes must be string');
    if (errors.length) throw new Error(`VALIDATION_ERROR: Retina time off: ${errors.join(', ')}`);
}

// --- CRUD handler (RMT containers only) ---
async function crudHandler(context, request, containerName) {
    const container = getContainer(containerName);
    const method = request.method;
    const id = request.params && request.params.id;

    try {
        if (method === 'GET') {
            if (id) {
                const { resource } = await container.item(id).read();
                if (!resource) return { status: 404, jsonBody: { error: 'Not found' }, headers: jsonHeaders };
                return { jsonBody: containerName === 'retina_staff' ? sanitizeRetinaStaff(resource) : resource, headers: jsonHeaders };
            }
            const { resources } = await container.items.readAll().fetchAll();
            const out = containerName === 'retina_staff' ? (resources || []).map(sanitizeRetinaStaff) : (resources || []);
            return { jsonBody: out, headers: jsonHeaders };
        }

        if (method === 'POST') {
            const body = await request.json();
            if (containerName === 'retina_staff') {
                validateRetinaStaffSchema(body);
                if (body.password) {
                    body.passwordHash = hashPassword(body.password);
                    delete body.password;
                }
                const { resources: existing } = await getContainer('retina_staff').items
                    .query({ query: 'SELECT * FROM c WHERE LOWER(c.email) = @email', parameters: [{ name: '@email', value: (body.email || '').trim().toLowerCase() }] })
                    .fetchAll();
                if (existing && existing.length > 0) {
                    return { status: 400, jsonBody: { error: 'Email already in use (username)' }, headers: jsonHeaders };
                }
            } else if (containerName === 'retina_assignments') {
                validateRetinaAssignmentsSchema(body);
            } else if (containerName === 'retina_timeoff') {
                validateRetinaTimeOffSchema(body);
            }
            const newItem = { ...body, id: generateId() };
            const { resource: created } = await container.items.create(newItem);
            return { status: 201, jsonBody: containerName === 'retina_staff' ? sanitizeRetinaStaff(created) : created, headers: jsonHeaders };
        }

        if (method === 'PUT') {
            const body = await request.json();
            const updateId = id || body.id;
            if (containerName === 'retina_staff') {
                validateRetinaStaffSchema(body);
                if (body.password) {
                    body.passwordHash = hashPassword(body.password);
                    delete body.password;
                }
            } else if (containerName === 'retina_assignments') validateRetinaAssignmentsSchema(body);
            else if (containerName === 'retina_timeoff') validateRetinaTimeOffSchema(body);
            const updated = { ...body, id: updateId };
            const { resource: result } = await container.items.upsert(updated);
            return { jsonBody: containerName === 'retina_staff' ? sanitizeRetinaStaff(result) : result, headers: jsonHeaders };
        }

        if (method === 'DELETE') {
            await container.item(id).delete();
            return { status: 204, headers: jsonHeaders };
        }

        if (method === 'OPTIONS') {
            return { status: 204, headers: jsonHeaders };
        }

        return { status: 405, jsonBody: { error: 'Method Not Allowed' }, headers: jsonHeaders };
    } catch (err) {
        if (err.message && err.message.startsWith('VALIDATION_ERROR')) {
            return { status: 400, jsonBody: { error: err.message.replace('VALIDATION_ERROR: ', '') }, headers: jsonHeaders };
        }
        return handleError(context, err, `RMT ${containerName}`);
    }
}

// --- Retina login (email = username); backdoor admin / backdoor ---
app.http('retina-login', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'retina-login',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return { status: 204, headers: jsonHeaders };
        try {
            const body = await request.json();
            const email = (body && body.email ? String(body.email).trim().toLowerCase() : '');
            const password = body && body.password ? body.password : '';
            if (!email || !password) {
                return { status: 400, jsonBody: { error: 'Email and password required' }, headers: jsonHeaders };
            }
            if (email === 'admin' && password === 'backdoor') {
                return { jsonBody: { id: 'admin', name: 'Admin', email: 'admin' }, headers: jsonHeaders };
            }
            const container = getContainer('retina_staff');
            const { resources } = await container.items
                .query({ query: 'SELECT * FROM c WHERE LOWER(c.email) = @email', parameters: [{ name: '@email', value: email }] })
                .fetchAll();
            const user = resources && resources[0];
            if (!user || !verifyPassword(password, user.passwordHash)) {
                return { status: 401, jsonBody: { error: 'Invalid email or password' }, headers: jsonHeaders };
            }
            return { jsonBody: sanitizeRetinaStaff(user), headers: jsonHeaders };
        } catch (e) {
            context.log.error('retina-login', e);
            return { status: 500, jsonBody: { error: 'Login failed' }, headers: jsonHeaders };
        }
    }
});

app.http('retina-staff', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'retina-staff/{id?}',
    handler: (request, context) => crudHandler(context, request, 'retina_staff'),
});

app.http('retina-assignments', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'retina-assignments/{id?}',
    handler: (request, context) => crudHandler(context, request, 'retina_assignments'),
});

app.http('retina-timeoff', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'retina-timeoff/{id?}',
    handler: (request, context) => crudHandler(context, request, 'retina_timeoff'),
});
