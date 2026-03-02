const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');

// Password hashing for CRC logins (CHAOS only). Never return passwordHash to client.
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_ITERATIONS = 100000;
const PASSWORD_KEYLEN = 64;

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

// Strip login-sensitive fields from API responses (crcs = CRC logins for CHAOS only).
function sanitizeLoginFields(containerName, item) {
    if (!item) return item;
    if (containerName === 'crcs') {
        const { passwordHash, password, ...rest } = item;
        return rest;
    }
    return item;
}

// Helper function to generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Helper function to get Cosmos DB client (lazy initialization)
let cosmosClient = null;
let database = null;

const getCosmosClient = () => {
    if (!cosmosClient) {
        // --- SECURITY FIX: READ SECRETS ONLY FROM PROCESS.ENV ---
        const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
        const COSMOS_KEY = process.env.COSMOS_KEY;
        const DATABASE_ID = process.env.DATABASE_ID;
        // --------------------------------------------------------

        if (!COSMOS_ENDPOINT || !COSMOS_KEY || !DATABASE_ID) {
            // CRITICAL: Throw a clear, custom error that can be caught and serialized.
            throw new Error("COSMOS_DB_CONFIG_MISSING: Missing required Cosmos DB environment variables (Endpoint, Key, or Database ID). Check Azure Configuration.");
        }

        cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
        database = cosmosClient.database(DATABASE_ID);
    }
    return { client: cosmosClient, database };
};

// Helper function to get container
const getContainer = (containerName) => {
    const { database } = getCosmosClient();
    return database.container(containerName);
};

// Helper function to handle errors
// This is the V4-compatible error handler, returning a structured object
const handleError = (context, error, message) => {
    context.log.error(`${message}:`, error.message);
    context.log.error(`Stack:`, error.stack);

    let errorMessage;
    if (error.message.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else {
        // For security, only return a generic message to the frontend client
        errorMessage = "Internal Server Error during data processing.";
    }

    // Returning a structured V4 response that is guaranteed to be valid JSON
    return {
        status: 500,
        jsonBody: { 
            error: errorMessage,
            // Only include detailed message in debug logs, not the response body
        },
        headers: {
            // These headers are technically redundant as staticwebapp.config.json handles them, but good practice
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    };
};


// =================================================================================
// DEDICATED HANDLER FUNCTIONS (V4 compatible)
// =================================================================================

// Helper to get ID from V4 route parameter
const getIdFromRequest = (request) => {
    // V4 router provides route parameters in request.params
    return request.params.id;
};

// =================================================================================
// SCHEMA VALIDATION FUNCTIONS (CHAOS / NASA / ARTEMIS only)
// =================================================================================

const validateStudiesSchema = (data) => {
    const errors = [];
    
    // Debug logging
    console.log('Validating study data:', JSON.stringify(data, null, 2));
    
    // Check if this is CHAOS format (has name, color, requiredRoles, sites)
    const isChaosFormat = data.name && data.color && (data.requiredRoles || data.sites);
    
    console.log('Is CHAOS format:', isChaosFormat);
    
    if (isChaosFormat) {
        // CHAOS format validation
        if (!data.name || typeof data.name !== 'string') {
            errors.push('name is required and must be a string');
        }
        
        if (data.title && typeof data.title !== 'string') {
            errors.push('title must be a string');
        }
        
        if (data.color && typeof data.color !== 'string') {
            errors.push('color must be a string');
        }
        
        if (data.requiredRoles && !Array.isArray(data.requiredRoles)) {
            errors.push('requiredRoles must be an array');
        }
        
        if (data.sites && !Array.isArray(data.sites)) {
            errors.push('sites must be an array');
        }
        
        if (data.siteRoleRequirements && typeof data.siteRoleRequirements !== 'object') {
            errors.push('siteRoleRequirements must be an object');
        }
        
        if (data.description && typeof data.description !== 'string') {
            errors.push('description must be a string');
        }
        
        if (data.status && !['active', 'inactive', 'completed', 'suspended'].includes(data.status.toLowerCase())) {
            errors.push('status must be one of: active, inactive, completed, suspended');
        }
        
        if (data.phase && typeof data.phase !== 'string') {
            errors.push('phase must be a string');
        }
        
        if (data.lastUpdated && typeof data.lastUpdated !== 'string') {
            errors.push('lastUpdated must be a string');
        }
    } else {
        // ARTEMIS/NASA format validation
        if (!data.title || typeof data.title !== 'string') {
            errors.push('title is required and must be a string');
        }
        
        if (data.protocolNumber && typeof data.protocolNumber !== 'string') {
            errors.push('protocolNumber must be a string');
        }
        
        if (data.target !== undefined && (typeof data.target !== 'number' || data.target < 0)) {
            errors.push('target must be a non-negative number');
        }
        
        if (data.status && !['Recruiting', 'Enrolling', 'Active', 'Completed', 'Suspended'].includes(data.status)) {
            errors.push('status must be one of: Recruiting, Enrolling, Active, Completed, Suspended');
        }
        
        if (data.indication && !Array.isArray(data.indication)) {
            errors.push('indication must be an array');
        }
        
        if (data.siteIds && !Array.isArray(data.siteIds)) {
            errors.push('siteIds must be an array');
        }
        
        if (data.washoutDays !== undefined && (typeof data.washoutDays !== 'number' || data.washoutDays < 0)) {
            errors.push('washoutDays must be a non-negative number');
        }
        
        if (data.siteEnrollmentGoals && typeof data.siteEnrollmentGoals !== 'object') {
            errors.push('siteEnrollmentGoals must be an object');
        }
        
        if (data.startDate && typeof data.startDate !== 'string') {
            errors.push('startDate must be a string');
        }
        
        if (data.endDate && typeof data.endDate !== 'string') {
            errors.push('endDate must be a string');
        }
        
        if (data.fpfv && typeof data.fpfv !== 'string') {
            errors.push('fpfv must be a string');
        }
        
        if (data.lplv && typeof data.lplv !== 'string') {
            errors.push('lplv must be a string');
        }
    }
    
    if (errors.length > 0) {
        console.error('Study validation errors:', errors);
        throw new Error(`VALIDATION_ERROR: Studies validation failed: ${errors.join(', ')}`);
    }
    
    console.log('Study validation passed');
    return true;
};

const validateSitesSchema = (data) => {
    const errors = [];
    
    if (!data.name || typeof data.name !== 'string') {
        errors.push('name is required and must be a string');
    }
    
    if (data.siteNameAbbreviation && typeof data.siteNameAbbreviation !== 'string') {
        errors.push('siteNameAbbreviation must be a string');
    }
    
    if (data.address1 && typeof data.address1 !== 'string') {
        errors.push('address1 must be a string');
    }
    
    if (data.address2 && typeof data.address2 !== 'string') {
        errors.push('address2 must be a string');
    }
    
    if (data.city && typeof data.city !== 'string') {
        errors.push('city must be a string');
    }
    
    if (data.state && typeof data.state !== 'string') {
        errors.push('state must be a string');
    }
    
    if (data.zipCode && typeof data.zipCode !== 'string') {
        errors.push('zipCode must be a string');
    }
    
    if (data.country && typeof data.country !== 'string') {
        errors.push('country must be a string');
    }
    
    if (data.pi && typeof data.pi !== 'string') {
        errors.push('pi must be a string');
    }
    
    if (data.piEmail && typeof data.piEmail !== 'string') {
        errors.push('piEmail must be a string');
    }
    
    if (data.siteCoordinator && typeof data.siteCoordinator !== 'string') {
        errors.push('siteCoordinator must be a string');
    }
    
    if (data.siteCoordinatorEmail && typeof data.siteCoordinatorEmail !== 'string') {
        errors.push('siteCoordinatorEmail must be a string');
    }
    
    if (data.indication && !Array.isArray(data.indication)) {
        errors.push('indication must be an array');
    }
    
    if (data.status && !['Active', 'Inactive', 'Suspended'].includes(data.status)) {
        errors.push('status must be one of: Active, Inactive, Suspended');
    }
    
    if (data.latitude !== undefined && (typeof data.latitude !== 'number' || data.latitude < -90 || data.latitude > 90)) {
        errors.push('latitude must be a number between -90 and 90');
    }
    
    if (data.longitude !== undefined && (typeof data.longitude !== 'number' || data.longitude < -180 || data.longitude > 180)) {
        errors.push('longitude must be a number between -180 and 180');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Sites validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validatePatientsSchema = (data) => {
    const errors = [];
    
    if (!data.firstName || typeof data.firstName !== 'string') {
        errors.push('firstName is required and must be a string');
    }
    
    if (!data.lastName || typeof data.lastName !== 'string') {
        errors.push('lastName is required and must be a string');
    }
    
    if (data.globalId && typeof data.globalId !== 'string') {
        errors.push('globalId must be a string');
    }
    
    if (data.phoneNumber && typeof data.phoneNumber !== 'string') {
        errors.push('phoneNumber must be a string');
    }
    
    if (data.email && typeof data.email !== 'string') {
        errors.push('email must be a string');
    }
    
    if (data.dob && typeof data.dob !== 'string') {
        errors.push('dob must be a string');
    }
    
    if (data.address && typeof data.address !== 'string') {
        errors.push('address must be a string');
    }
    
    if (data.city && typeof data.city !== 'string') {
        errors.push('city must be a string');
    }
    
    if (data.state && typeof data.state !== 'string') {
        errors.push('state must be a string');
    }
    
    if (data.zipCode && typeof data.zipCode !== 'string') {
        errors.push('zipCode must be a string');
    }
    
    if (data.age !== undefined && (typeof data.age !== 'number' || data.age < 0 || data.age > 150)) {
        errors.push('age must be a number between 0 and 150');
    }
    
    if (data.condition && typeof data.condition !== 'string') {
        errors.push('condition must be a string');
    }
    
    if (data.status && !['Candidate', 'Pre-Screening', 'Enrolled', 'Screen Fail', 'Completed'].includes(data.status)) {
        errors.push('status must be one of: Candidate, Pre-Screening, Enrolled, Screen Fail, Completed');
    }
    
    if (data.registryStatus && !['Active', 'Inactive'].includes(data.registryStatus)) {
        errors.push('registryStatus must be one of: Active, Inactive');
    }
    
    if (data.source && typeof data.source !== 'string') {
        errors.push('source must be a string');
    }
    
    if (data.therapeuticArea && typeof data.therapeuticArea !== 'string') {
        errors.push('therapeuticArea must be a string');
    }
    
    if (data.studyId && typeof data.studyId !== 'string') {
        errors.push('studyId must be a string');
    }
    
    if (data.siteId && typeof data.siteId !== 'string') {
        errors.push('siteId must be a string');
    }
    
    if (data.appointment && typeof data.appointment !== 'object') {
        errors.push('appointment must be an object');
    }
    
    if (data.surveyResults && !Array.isArray(data.surveyResults)) {
        errors.push('surveyResults must be an array');
    }
    
    if (data.contactLogs && !Array.isArray(data.contactLogs)) {
        errors.push('contactLogs must be an array');
    }
    
    if (data.studyHistory && !Array.isArray(data.studyHistory)) {
        errors.push('studyHistory must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Patients validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateCrcsSchema = (data) => {
    const errors = [];
    
    if (!data.name || typeof data.name !== 'string') {
        errors.push('name is required and must be a string');
    }
    
    // Email = CRC login username (optional; if present must be string)
    if (data.email !== undefined && data.email !== null && typeof data.email !== 'string') {
        errors.push('email must be a string');
    }
    
    if (data.title && typeof data.title !== 'string') {
        errors.push('title must be a string');
    }
    
    if (data.region && typeof data.region !== 'string') {
        errors.push('region must be a string');
    }
    
    if (data.capabilities && !Array.isArray(data.capabilities)) {
        errors.push('capabilities must be an array');
    }
    
    if (data.trainingLevel && typeof data.trainingLevel !== 'string') {
        errors.push('trainingLevel must be a string');
    }
    
    if (data.coordinates && typeof data.coordinates !== 'object') {
        errors.push('coordinates must be an object');
    }
    
    if (data.employmentType && !['FTE', 'PTE', 'Contractor'].includes(data.employmentType)) {
        errors.push('employmentType must be one of: FTE, PTE, Contractor');
    }
    
    if (data.homeLocation && typeof data.homeLocation !== 'string') {
        errors.push('homeLocation must be a string');
    }
    
    if (data.trainings && !Array.isArray(data.trainings)) {
        errors.push('trainings must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: CRCs validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

// Events = staff shifts (who is at which site/study when). CHAOS writes; NASA reads for patient scheduling.
const validateEventsSchema = (data) => {
    const errors = [];

    if (!data.crcId || typeof data.crcId !== 'string') {
        errors.push('crcId is required and must be a string');
    }
    if (!data.siteId || typeof data.siteId !== 'string') {
        errors.push('siteId is required and must be a string');
    }
    if (!data.studyId || typeof data.studyId !== 'string') {
        errors.push('studyId is required and must be a string');
    }
    if (!data.startTime || typeof data.startTime !== 'string') {
        errors.push('startTime is required and must be an ISO date-time string');
    }
    if (!data.endTime || typeof data.endTime !== 'string') {
        errors.push('endTime is required and must be an ISO date-time string');
    }

    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Events (shifts) validation failed: ${errors.join(', ')}`);
    }
    return true;
};

const validateRolesSchema = (data) => {
    const errors = [];
    
    if (!data.name || typeof data.name !== 'string') {
        errors.push('name is required and must be a string');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Roles validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateSchedulesSchema = (data) => {
    const errors = [];
    
    if (!data.siteId || typeof data.siteId !== 'string') {
        errors.push('siteId is required and must be a string');
    }
    
    if (!data.studyId || typeof data.studyId !== 'string') {
        errors.push('studyId is required and must be a string');
    }
    
    if (!data.visit || typeof data.visit !== 'string') {
        errors.push('visit is required and must be a string');
    }
    
    if (!data.slots || !Array.isArray(data.slots)) {
        errors.push('slots is required and must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Schedules validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateSurveysSchema = (data) => {
    const errors = [];
    
    if (!data.title || typeof data.title !== 'string') {
        errors.push('title is required and must be a string');
    }
    
    if (!data.studyId || typeof data.studyId !== 'string') {
        errors.push('studyId is required and must be a string');
    }
    
    if (!data.questions || !Array.isArray(data.questions)) {
        errors.push('questions is required and must be an array');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Surveys validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

// =================================================================================
// BUSINESS LOGIC FUNCTIONS
// =================================================================================

const calculateStudyEnrollment = async (studyId) => {
    try {
        const patientsContainer = getContainer('patients');
        const { resources: patients } = await patientsContainer.items
            .query({
                query: "SELECT * FROM c WHERE c.studyId = @studyId",
                parameters: [{ name: "@studyId", value: studyId }]
            })
            .fetchAll();
        
        return patients.length;
    } catch (error) {
        console.error('Error calculating study enrollment:', error);
        return 0;
    }
};

const validateSiteStudyRelationship = async (siteId, studyId) => {
    try {
        const studiesContainer = getContainer('studies');
        const { resource: study } = await studiesContainer.item(studyId).read();
        
        if (!study) {
            throw new Error('Study not found');
        }
        
        if (!study.siteIds || !study.siteIds.includes(siteId)) {
            throw new Error('Site is not assigned to this study');
        }
        
        return true;
    } catch (error) {
        throw new Error(`Site-Study relationship validation failed: ${error.message}`);
    }
};

// =================================================================================
// ENHANCED CRUD HANDLERS
// =================================================================================

async function crudHandler(context, request, containerName) {
    // This is the first line to be executed inside the function, where the crash prevention starts
    
    const container = getContainer(containerName);
    const { method } = request;
    const id = getIdFromRequest(request);

    try {
        switch (method) {
            case 'GET':
                if (id) {
                    const { resource } = await container.item(id).read(); 
                    if (!resource) return { status: 404, jsonBody: { error: `${containerName} not found` } };
                    return { jsonBody: sanitizeLoginFields(containerName, resource) };
                } else {
                    const { resources } = await container.items.readAll().fetchAll();
                    const sanitized = (resources || []).map(r => sanitizeLoginFields(containerName, r));
                    return { jsonBody: sanitized };
                }
            
            case 'POST':
                const body = await request.json();
                
                // Validate schema (CHAOS/NASA/ARTEMIS containers only)
                try {
                    switch (containerName) {
                        case 'studies':
                            validateStudiesSchema(body);
                            break;
                        case 'sites':
                            validateSitesSchema(body);
                            break;
                        case 'patients':
                            validatePatientsSchema(body);
                            break;
                        case 'crcs':
                            validateCrcsSchema(body);
                            break;
                        case 'events':
                            validateEventsSchema(body);
                            await validateSiteStudyRelationship(body.siteId, body.studyId);
                            break;
                        case 'roles':
                            validateRolesSchema(body);
                            break;
                        case 'schedules':
                            validateSchedulesSchema(body);
                            await validateSiteStudyRelationship(body.siteId, body.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(body);
                            break;
                    }
                } catch (validationError) {
                    console.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                // CRC login: hash password, never store plain (CHAOS only)
                if (containerName === 'crcs' && body.password) {
                    body.passwordHash = hashPassword(body.password);
                    delete body.password;
                }
                
                const newItem = { ...body, id: generateId() };
                const { resource: createdItem } = await container.items.create(newItem);
                
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(createdItem.id);
                    createdItem.enrolled = enrollment;
                }
                
                return { status: 201, jsonBody: sanitizeLoginFields(containerName, createdItem) };
            
            case 'PUT':
                const requestBody = await request.json();
                const updateId = id || requestBody.id;
                
                try {
                    switch (containerName) {
                        case 'studies':
                            validateStudiesSchema(requestBody);
                            break;
                        case 'sites':
                            validateSitesSchema(requestBody);
                            break;
                        case 'patients':
                            validatePatientsSchema(requestBody);
                            break;
                        case 'crcs':
                            validateCrcsSchema(requestBody);
                            break;
                        case 'events':
                            validateEventsSchema(requestBody);
                            await validateSiteStudyRelationship(requestBody.siteId, requestBody.studyId);
                            break;
                        case 'roles':
                            validateRolesSchema(requestBody);
                            break;
                        case 'schedules':
                            validateSchedulesSchema(requestBody);
                            await validateSiteStudyRelationship(requestBody.siteId, requestBody.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(requestBody);
                            break;
                    }
                } catch (validationError) {
                    console.error(`Validation error for ${containerName}:`, validationError.message);
                    return {
                        status: 400,
                        jsonBody: { error: validationError.message },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                if (containerName === 'crcs' && requestBody.password) {
                    requestBody.passwordHash = hashPassword(requestBody.password);
                    delete requestBody.password;
                }
                
                const updatedItem = { ...requestBody, id: updateId };
                const { resource: result } = await container.items.upsert(updatedItem);
                
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(result.id);
                    result.enrolled = enrollment;
                }
                
                return { jsonBody: sanitizeLoginFields(containerName, result) };

            case 'DELETE':
                await container.item(id).delete();
                return { status: 204 };

            case 'OPTIONS':
                return { status: 200 };

            default:
                return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
        }
    } catch (error) {
        // Catch any error during the database operation
        return handleError(context, error, `Database operation failed on ${containerName}`);
    }
}


// =================================================================================
// V4 FUNCTION REGISTRATION (The Indexing that fixes the 404)
// =================================================================================

app.http('studies', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'studies/{id?}', 
    handler: (request, context) => crudHandler(context, request, 'studies'),
});

app.http('sites', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'sites/{id?}',
    handler: (request, context) => crudHandler(context, request, 'sites'),
});

app.http('patients', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'patients/{id?}',
    handler: (request, context) => crudHandler(context, request, 'patients'),
});

app.http('crcs', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'crcs/{id?}',
    handler: (request, context) => crudHandler(context, request, 'crcs'),
});

app.http('events', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'events/{id?}',
    handler: (request, context) => crudHandler(context, request, 'events'),
});

app.http('roles', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'roles/{id?}',
    handler: (request, context) => crudHandler(context, request, 'roles'),
});

app.http('training-types', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'training-types/{id?}',
    handler: (request, context) => crudHandler(context, request, 'training_types'),
});

// =================================================================================
// CHAOS CRC LOGIN (this API only – no shared code with RMT)
// =================================================================================

const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

app.http('crc-login', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'crc-login',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return { status: 204, headers: jsonHeaders };
        try {
            const body = await request.json();
            const email = body && body.email ? String(body.email).trim().toLowerCase() : '';
            const password = body && body.password ? body.password : '';
            if (!email || !password) {
                return { status: 400, jsonBody: { error: 'Email and password are required' }, headers: jsonHeaders };
            }
            const container = getContainer('crcs');
            const { resources } = await container.items
                .query({ query: 'SELECT * FROM c WHERE LOWER(c.email) = @email', parameters: [{ name: '@email', value: email }] })
                .fetchAll();
            const user = resources && resources[0];
            if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
                return { status: 401, jsonBody: { error: 'Invalid email or password' }, headers: jsonHeaders };
            }
            return { jsonBody: sanitizeLoginFields('crcs', user), headers: jsonHeaders };
        } catch (e) {
            context.log.error('crc-login', e);
            return { status: 500, jsonBody: { error: 'Login failed' }, headers: jsonHeaders };
        }
    }
});
