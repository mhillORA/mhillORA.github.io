const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

// Use node-fetch instead of native fetch for Azure Functions compatibility
// Native fetch is broken in Azure Functions environment
// Import node-fetch using require (v2 supports CommonJS)
let fetch;
let fetchError = null;
const getFetch = async () => {
    if (fetchError) {
        throw fetchError;
    }
    if (!fetch) {
        try {
            // Try CommonJS require first (node-fetch v2)
            try {
                fetch = require('node-fetch');
            } catch (requireError) {
                // Fallback to ESM import (node-fetch v3)
                const nodeFetch = await import('node-fetch');
                fetch = nodeFetch.default;
            }
        } catch (importError) {
            fetchError = importError;
            throw new Error(`Failed to import node-fetch: ${importError.message}. Make sure node-fetch is installed in package.json.`);
        }
    }
    return fetch;
};

// Temporary Navan API credentials for local testing only.
// These should never be used in production deployments.
const NAVAN_TEST_CLIENT_ID = 'b255eefb-978a-4a1b-a8b1-fb069d7f8b43';
const NAVAN_TEST_SECRET_KEY = '8ef37280136f4e388cc499df9952e836';

const NAVAN_DEFAULT_BASE_URL = 'https://app.navan.com/v1';
const NAVAN_DEFAULT_AUTH_URL = 'https://api.navan.com/ta-auth/oauth/token';

let navanTokenCache = {
    token: null,
    expiresAt: 0,
    clientId: null
};

const resolveNavanCredentials = (context) => {
    const envClientId = process.env.NAVAN_CLIENT_ID;
    const envClientSecret = process.env.NAVAN_SECRET_KEY;

    if (envClientId && envClientSecret) {
        return {
            clientId: envClientId,
            clientSecret: envClientSecret,
            source: 'environment'
        };
    }

    if (envClientId || envClientSecret) {
        context?.log?.warn?.('Incomplete Navan credentials found in environment variables. Falling back to hardcoded test credentials.');
    } else {
        context?.log?.warn?.('Navan credentials not found in environment. Using hardcoded test credentials. Do not use in production.');
    }

    return {
        clientId: NAVAN_TEST_CLIENT_ID,
        clientSecret: NAVAN_TEST_SECRET_KEY,
        source: 'hardcoded-test'
    };
};

const resolveNavanEndpoints = (context) => {
    const baseUrlRaw = (process.env.NAVAN_BASE_URL || '').trim();
    const authUrlRaw = (process.env.NAVAN_AUTH_URL || '').trim();
    const baseUrl = baseUrlRaw || NAVAN_DEFAULT_BASE_URL;
    let authUrl = authUrlRaw;

    if (!authUrl) {
        authUrl = `${baseUrl.replace(/\/$/, '')}/auth/token`;
        context?.log?.info?.(`Navan auth URL derived from base URL: ${authUrl}`);
    } else {
        context?.log?.info?.(`Navan auth URL loaded from environment: ${authUrl}`);
    }

    return {
        baseUrl,
        authUrl
    };
};

const getNavanAuthToken = async (context, fetchFn, clientId, clientSecret) => {
    const now = Date.now();
    if (navanTokenCache.token && navanTokenCache.clientId === clientId && navanTokenCache.expiresAt - now > 60_000) {
        context?.log?.info?.('Using cached Navan access token');
        return navanTokenCache.token;
    }

    const { authUrl } = resolveNavanEndpoints(context);
    context?.log?.info?.(`Requesting new Navan OAuth token from ${authUrl}`);

    let response;
    try {
        response = await fetchFn(authUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            })
        });
    } catch (error) {
        navanTokenCache = { token: null, expiresAt: 0, clientId: null };
        throw new Error(`Network error requesting Navan token: ${error.message}`);
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read response body');
        navanTokenCache = { token: null, expiresAt: 0, clientId: null };
        throw new Error(`Navan token request failed with status ${response.status}: ${errorText}`);
    }

    let data;
    try {
        data = await response.json();
    } catch (error) {
        navanTokenCache = { token: null, expiresAt: 0, clientId: null };
        throw new Error(`Failed to parse Navan token response JSON: ${error.message}`);
    }

    const accessToken = data.access_token || data.token;
    if (!accessToken) {
        navanTokenCache = { token: null, expiresAt: 0, clientId: null };
        throw new Error('Navan token response did not contain access_token');
    }

    const expiresInSeconds = Number(data.expires_in || data.expiresIn || 300);
    const ttl = Number.isFinite(expiresInSeconds) ? Math.max(expiresInSeconds - 60, 120) * 1000 : 5 * 60 * 1000;
    navanTokenCache = {
        token: accessToken,
        expiresAt: now + ttl,
        clientId
    };

    context?.log?.info?.(`Navan access token retrieved (${Math.round(ttl / 1000)}s cache window)`);

    return accessToken;
};

// Helper function to generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Helper function to get Cosmos DB client (lazy initialization)
let cosmosClient = null;
let database = null;

const getCosmosClient = () => {
    if (!cosmosClient) {
        const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
        const COSMOS_KEY = process.env.COSMOS_KEY;
        const DATABASE_ID = process.env.DATABASE_ID;

        if (!COSMOS_ENDPOINT || !COSMOS_KEY || !DATABASE_ID) {
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
const handleError = (context, error, message) => {
    context.log.error(`${message}:`, error.message);
    context.log.error(`Stack:`, error.stack);

    let errorMessage;
    let errorDetail = error.message || "Unknown error";
    let errorStack = error.stack || "No stack trace";

    if (error.message.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else if (error.message.includes('VALIDATION_ERROR')) {
        errorMessage = error.message.replace('VALIDATION_ERROR: ', '');
    } else {
        errorMessage = "Internal Server Error during data processing.";
    }

    return {
        status: 500,
        jsonBody: { 
            error: errorMessage,
            // Add detailed error information for debugging
            detail: errorDetail,
            stack: errorStack,
            originalMessage: message
        },
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    };
};

// Helper to get ID from V4 route parameter
const getIdFromRequest = (request) => {
    return request.params.id;
};

// =================================================================================
// SCHEMA VALIDATION FUNCTIONS
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

const validateEventsSchema = (data) => {
    if (!data || typeof data !== 'object') {
        throw new Error('VALIDATION_ERROR: Events validation failed: payload must be an object');
    }

    const errors = [];

    const ensureStringField = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null) return;
        if (typeof data[fieldName] !== 'string') {
            errors.push(`${fieldName} must be a string`);
        } else if (fieldName === 'type' && data[fieldName].trim() === '') {
            errors.push('type is required and must be a non-empty string');
        }
    };

    const ensureDateField = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null) return;
        if (typeof data[fieldName] !== 'string' || data[fieldName].trim() === '') {
            errors.push(`${fieldName} must be a non-empty string`);
            return;
        }
        if (Number.isNaN(Date.parse(data[fieldName]))) {
            errors.push(`${fieldName} must be a valid date string`);
        }
    };

    const normalizeNumberField = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null || data[fieldName] === '') return;
        if (typeof data[fieldName] === 'string') {
            const parsed = Number(data[fieldName]);
            if (Number.isNaN(parsed)) {
                errors.push(`${fieldName} must be a number`);
                return;
            }
            data[fieldName] = parsed;
        } else if (typeof data[fieldName] !== 'number' || !Number.isFinite(data[fieldName])) {
            errors.push(`${fieldName} must be a number`);
        }
    };

    const ensureStringArray = (fieldName) => {
        if (data[fieldName] === undefined || data[fieldName] === null) return;
        if (Array.isArray(data[fieldName])) {
            data[fieldName].forEach((value, index) => {
                if (typeof value !== 'string' || value.trim() === '') {
                    errors.push(`${fieldName}[${index}] must be a non-empty string`);
                }
            });
        } else if (typeof data[fieldName] === 'string' && data[fieldName].trim() !== '') {
            data[fieldName] = [data[fieldName]];
        } else {
            errors.push(`${fieldName} must be an array of strings`);
        }
    };

    if (!data.type || typeof data.type !== 'string' || data.type.trim() === '') {
        errors.push('type is required and must be a non-empty string');
    }

    const hasDate = Object.prototype.hasOwnProperty.call(data, 'date');
    const hasStartDate = Object.prototype.hasOwnProperty.call(data, 'startDate');
    const hasEndDate = Object.prototype.hasOwnProperty.call(data, 'endDate');

    if (!hasDate && !hasStartDate && !hasEndDate) {
        errors.push('an event must include date or startDate/endDate');
    }

    ensureDateField('date');
    ensureDateField('startDate');
    ensureDateField('endDate');

    if ((hasStartDate && !hasEndDate) || (!hasStartDate && hasEndDate)) {
        errors.push('startDate and endDate must both be provided together');
    }

    if (hasStartDate && hasEndDate && typeof data.startDate === 'string' && typeof data.endDate === 'string') {
        const startTime = Date.parse(data.startDate);
        const endTime = Date.parse(data.endDate);
        if (!Number.isNaN(startTime) && !Number.isNaN(endTime) && startTime > endTime) {
            errors.push('startDate cannot be after endDate');
        }
    }

    [
        'name',
        'crcId',
        'siteId',
        'studyId',
        'groupId',
        'groupNumber',
        'period',
        'notes',
        'visitNumber',
        'principalInvestigator',
        'truckId',
        'timeOffRequestId',
        'status',
        'createdAt'
    ].forEach(ensureStringField);

    normalizeNumberField('hours');
    normalizeNumberField('mileage');

    if (data.isOverridden !== undefined && typeof data.isOverridden !== 'boolean') {
        errors.push('isOverridden must be a boolean');
    }

    ensureStringArray('studyIds');
    ensureStringArray('roles');

    if (data.roleAssignments !== undefined && data.roleAssignments !== null) {
        if (typeof data.roleAssignments !== 'object' || Array.isArray(data.roleAssignments)) {
            errors.push('roleAssignments must be an object mapping role IDs to arrays of CRC IDs');
        } else {
            Object.entries(data.roleAssignments).forEach(([roleId, assignments]) => {
                if (!Array.isArray(assignments)) {
                    errors.push(`roleAssignments["${roleId}"] must be an array`);
                    return;
                }
                assignments.forEach((value, index) => {
                    if (value !== null && value !== undefined && typeof value !== 'string') {
                        errors.push(`roleAssignments["${roleId}"][${index}] must be a string or null`);
                    }
                });
            });
        }
    }

    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Events validation failed: ${errors.join(', ')}`);
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

const validateUsersSchema = (data) => {
    const errors = [];
    
    if (!data.username || typeof data.username !== 'string') {
        errors.push('username is required and must be a string');
    }
    
    if (data.password && typeof data.password !== 'string') {
        errors.push('password must be a string');
    }
    
    if (data.permissionLevel && !['Manager', 'Supervisor', 'CRC'].includes(data.permissionLevel)) {
        errors.push('permissionLevel must be one of: Manager, Supervisor, CRC');
    }
    
    if (data.entraId && typeof data.entraId !== 'string') {
        errors.push('entraId must be a string');
    }
    
    if (data.email && typeof data.email !== 'string') {
        errors.push('email must be a string');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Users validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

// Simple password hashing (in production, use bcrypt or similar)
const hashPassword = (password) => {
    // Simple hash for now - in production use proper bcrypt
    return Buffer.from(password).toString('base64');
};

const verifyPassword = (password, hash) => {
    return hashPassword(password) === hash;
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

const validateTimeOffRequestsSchema = (data) => {
    const errors = [];
    
    if (!data.crcId || typeof data.crcId !== 'string') {
        errors.push('crcId is required and must be a string');
    }
    
    if (!data.date || typeof data.date !== 'string') {
        errors.push('date is required and must be a string');
    }
    
    if (!data.type || typeof data.type !== 'string') {
        errors.push('type is required and must be a string');
    }
    
    if (data.period && typeof data.period !== 'string') {
        errors.push('period must be a string');
    }
    
    if (data.hours !== undefined && (typeof data.hours !== 'number' || data.hours < 0)) {
        errors.push('hours must be a non-negative number');
    }
    
    if (data.status && !['pending', 'approved', 'rejected'].includes(data.status)) {
        errors.push('status must be one of: pending, approved, rejected');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Time Off Requests validation failed: ${errors.join(', ')}`);
    }
    
    return true;
};

const validateTravelSchema = (data) => {
    const errors = [];
    
    if (!data.crcId || typeof data.crcId !== 'string') {
        errors.push('crcId is required and must be a string');
    }
    
    if (!data.date || typeof data.date !== 'string') {
        errors.push('date is required and must be a string');
    }
    
    if (data.flightNumber && typeof data.flightNumber !== 'string') {
        errors.push('flightNumber must be a string');
    }
    
    if (data.origin && typeof data.origin !== 'string') {
        errors.push('origin must be a string');
    }
    
    if (data.destination && typeof data.destination !== 'string') {
        errors.push('destination must be a string');
    }
    
    // Convert empty strings to undefined for cost fields, then validate
    const flightCost = data.flightCost === '' || data.flightCost === null ? undefined : data.flightCost;
    const carRentalCost = data.carRentalCost === '' || data.carRentalCost === null ? undefined : data.carRentalCost;
    const hotelCost = data.hotelCost === '' || data.hotelCost === null ? undefined : data.hotelCost;
    
    // Convert string numbers to numbers
    if (flightCost !== undefined) {
        const num = typeof flightCost === 'string' ? parseFloat(flightCost) : flightCost;
        if (isNaN(num) || num < 0) {
            errors.push('flightCost must be a non-negative number');
        }
    }
    
    if (carRentalCost !== undefined) {
        const num = typeof carRentalCost === 'string' ? parseFloat(carRentalCost) : carRentalCost;
        if (isNaN(num) || num < 0) {
            errors.push('carRentalCost must be a non-negative number');
        }
    }
    
    if (hotelCost !== undefined) {
        const num = typeof hotelCost === 'string' ? parseFloat(hotelCost) : hotelCost;
        if (isNaN(num) || num < 0) {
            errors.push('hotelCost must be a non-negative number');
        }
    }
    
    if (data.status && !['scheduled', 'delayed', 'departed', 'arrived', 'cancelled'].includes(data.status)) {
        errors.push('status must be one of: scheduled, delayed, departed, arrived, cancelled');
    }
    
    if (errors.length > 0) {
        throw new Error(`VALIDATION_ERROR: Travel validation failed: ${errors.join(', ')}`);
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
    let container;
    try {
        container = getContainer(containerName);
    } catch (error) {
        // If we can't even get the container reference, return empty array for travel
        if (containerName === 'travel' && request.method === 'GET') {
            context.log.warn(`Error getting travel container reference, returning empty array. Error: ${error.message}`);
            return { 
                jsonBody: [],
                headers: { 'Content-Type': 'application/json' }
            };
        }
        throw error;
    }
    
    const { method } = request;
    const id = getIdFromRequest(request);

    try {
        switch (method) {
            case 'GET':
                if (id) {
                    try {
                        // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                        const { resource } = await container.item(id, id).read(); 
                        if (!resource) return { status: 404, jsonBody: { error: `${containerName} not found` } };
                        return { jsonBody: resource };
                    } catch (error) {
                        // If container doesn't exist, return 404
                        if (error.code === 404 || error.message.includes('NotFound')) {
                            return { status: 404, jsonBody: { error: `${containerName} not found` } };
                        }
                        throw error;
                    }
                } else {
                    try {
                        const { resources } = await container.items.readAll().fetchAll();
                        return { jsonBody: resources };
                    } catch (error) {
                        // If container doesn't exist yet, return empty array
                        // Cosmos DB errors can have different formats:
                        // - error.code === 404
                        // - error.statusCode === 404
                        // - error.message includes 'NotFound', 'Container', or 'not found'
                        const errorCode = error.code || error.statusCode;
                        const errorMessage = (error.message || '').toLowerCase();
                        
                        // For travel container specifically, always return empty array on any error
                        // This prevents launch failures
                        if (containerName === 'travel') {
                            context.log.warn(`Travel container does not exist yet or error occurred, returning empty array. Error: ${error.message}`);
                            return { 
                                jsonBody: [],
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        if (errorCode === 404 || 
                            errorCode === 400 ||
                            errorMessage.includes('notfound') || 
                            errorMessage.includes('not found') ||
                            errorMessage.includes('container') ||
                            errorMessage.includes('does not exist') ||
                            errorMessage.includes('bad request')) {
                            context.log.warn(`Container '${containerName}' does not exist yet, returning empty array`);
                            return { 
                                jsonBody: [],
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        // Log the actual error for debugging
                        context.log.error(`Error reading from container '${containerName}':`, error);
                        context.log.error(`Error code: ${errorCode}, message: ${errorMessage}`);
                        throw error;
                    }
                }
            
            case 'POST':
                const body = await request.json();
                
                // Normalize cost fields for travel - convert empty strings to undefined
                if (containerName === 'travel') {
                    if (body.flightCost === '' || body.flightCost === null) body.flightCost = undefined;
                    if (body.carRentalCost === '' || body.carRentalCost === null) body.carRentalCost = undefined;
                    if (body.hotelCost === '' || body.hotelCost === null) body.hotelCost = undefined;
                    
                    // Convert string numbers to numbers
                    if (body.flightCost !== undefined && typeof body.flightCost === 'string') {
                        body.flightCost = parseFloat(body.flightCost) || undefined;
                    }
                    if (body.carRentalCost !== undefined && typeof body.carRentalCost === 'string') {
                        body.carRentalCost = parseFloat(body.carRentalCost) || undefined;
                    }
                    if (body.hotelCost !== undefined && typeof body.hotelCost === 'string') {
                        body.hotelCost = parseFloat(body.hotelCost) || undefined;
                    }
                }
                
                // Normalize zip code fields for sites - map zip, postalCode, postal_code to zipCode
                if (containerName === 'sites') {
                    if (body.zip && !body.zipCode) {
                        body.zipCode = body.zip;
                    }
                    if (body.postalCode && !body.zipCode) {
                        body.zipCode = body.postalCode;
                    }
                    if (body.postal_code && !body.zipCode) {
                        body.zipCode = body.postal_code;
                    }
                }
                
                // Validate schema based on container
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
                            break;
                        case 'roles':
                            validateRolesSchema(body);
                            break;
                        case 'users':
                            validateUsersSchema(body);
                            // Hash password if provided
                            if (body.password) {
                                body.password = hashPassword(body.password);
                            }
                            break;
                        case 'schedules':
                            validateSchedulesSchema(body);
                            // Validate site-study relationship
                            await validateSiteStudyRelationship(body.siteId, body.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(body);
                            break;
                        case 'time-off-requests':
                            validateTimeOffRequestsSchema(body);
                            break;
                        case 'travel':
                            validateTravelSchema(body);
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
                
                const newItem = { ...body, id: generateId() };
                const { resource: createdItem } = await container.items.create(newItem);
                
                // Calculate enrollment for studies
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(createdItem.id);
                    createdItem.enrolled = enrollment;
                }
                
                return { status: 201, jsonBody: createdItem };
            
            case 'PUT':
                const requestBody = await request.json();
                const updateId = id || requestBody.id;
                
                // Normalize cost fields for travel - convert empty strings to undefined
                if (containerName === 'travel') {
                    if (requestBody.flightCost === '' || requestBody.flightCost === null) requestBody.flightCost = undefined;
                    if (requestBody.carRentalCost === '' || requestBody.carRentalCost === null) requestBody.carRentalCost = undefined;
                    if (requestBody.hotelCost === '' || requestBody.hotelCost === null) requestBody.hotelCost = undefined;
                    
                    // Convert string numbers to numbers
                    if (requestBody.flightCost !== undefined && typeof requestBody.flightCost === 'string') {
                        requestBody.flightCost = parseFloat(requestBody.flightCost) || undefined;
                    }
                    if (requestBody.carRentalCost !== undefined && typeof requestBody.carRentalCost === 'string') {
                        requestBody.carRentalCost = parseFloat(requestBody.carRentalCost) || undefined;
                    }
                    if (requestBody.hotelCost !== undefined && typeof requestBody.hotelCost === 'string') {
                        requestBody.hotelCost = parseFloat(requestBody.hotelCost) || undefined;
                    }
                }
                
                // Normalize zip code fields for sites - map zip, postalCode, postal_code to zipCode
                if (containerName === 'sites') {
                    if (requestBody.zip && !requestBody.zipCode) {
                        requestBody.zipCode = requestBody.zip;
                    }
                    if (requestBody.postalCode && !requestBody.zipCode) {
                        requestBody.zipCode = requestBody.postalCode;
                    }
                    if (requestBody.postal_code && !requestBody.zipCode) {
                        requestBody.zipCode = requestBody.postal_code;
                    }
                }
                
                // Validate schema based on container
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
                            break;
                        case 'roles':
                            validateRolesSchema(requestBody);
                            break;
                        case 'users':
                            validateUsersSchema(requestBody);
                            // Hash password if provided
                            if (requestBody.password) {
                                requestBody.password = hashPassword(requestBody.password);
                            }
                            break;
                        case 'schedules':
                            validateSchedulesSchema(requestBody);
                            // Validate site-study relationship
                            await validateSiteStudyRelationship(requestBody.siteId, requestBody.studyId);
                            break;
                        case 'surveys':
                            validateSurveysSchema(requestBody);
                            break;
                        case 'time-off-requests':
                            validateTimeOffRequestsSchema(requestBody);
                            break;
                        case 'travel':
                            validateTravelSchema(requestBody);
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
                
                const updatedItem = { ...requestBody, id: updateId };
                const { resource: result } = await container.items.upsert(updatedItem);
                
                // Calculate enrollment for studies
                if (containerName === 'studies') {
                    const enrollment = await calculateStudyEnrollment(result.id);
                    result.enrolled = enrollment;
                }
                
                return { jsonBody: result };

            case 'DELETE':
                if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                try {
                    // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                    const { resource } = await container.item(id, id).read();
                    if (!resource) {
                        // Treat missing as already deleted
                        return { status: 204 };
                    }
                } catch (e) {
                    // If read fails (e.g., not found), return 204 for idempotency
                    return { status: 204 };
                }
                // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                await container.item(id, id).delete();
                return { status: 204 };

            case 'OPTIONS':
                return { status: 200 };

            default:
                return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
        }
    } catch (error) {
        // Special handling for travel container - if it doesn't exist yet, return empty array for GET requests
        // This is a new container that might not exist yet, so we're defensive about errors
        if (containerName === 'travel' && method === 'GET') {
            const errorCode = error.code || error.statusCode;
            const errorMessage = (error.message || '').toLowerCase();
            
            // Log the error for debugging
            context.log.warn(`Error accessing travel container (might not exist yet):`, error.message);
            
            // If it's any kind of not-found or container-related error, return empty array
            // Also catch any other errors that might occur when container doesn't exist
            if (errorCode === 404 || 
                errorCode === 400 ||
                errorMessage.includes('notfound') || 
                errorMessage.includes('container') || 
                errorMessage.includes('does not exist') ||
                errorMessage.includes('not found') ||
                errorMessage.includes('bad request')) {
                context.log.warn(`Container '${containerName}' does not exist yet, returning empty array`);
                return { 
                    jsonBody: [],
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // For any other error on travel GET, also return empty array to prevent 500 errors
            // This is safe because GET requests are idempotent and returning empty array is valid
            context.log.warn(`Unexpected error accessing travel container, returning empty array:`, error.message);
            return { 
                jsonBody: [],
                headers: { 'Content-Type': 'application/json' }
            };
        }
        
        return handleError(context, error, `Database operation failed on ${containerName}`);
    }
}

// =================================================================================
// V4 FUNCTION REGISTRATION
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
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'training-types/{id?}',
    handler: async (request, context) => {
        try {
            // Build training types dynamically from CRC embedded trainings
            const container = getContainer('crcs');
            const { resources: crcs } = await container.items.readAll().fetchAll();
            const names = new Set();
            (crcs || []).forEach(crc => {
                (crc.trainings || []).forEach(t => {
                    if (t && typeof t.name === 'string' && t.name.trim() !== '') {
                        names.add(t.name.trim());
                    }
                });
            });
            const result = Array.from(names).sort().map(n => ({ id: n, name: n }));
            return { jsonBody: result };
        } catch (error) {
            return handleError(context, error, 'Build training-types from CRCs');
        }
    },
});

app.http('schedules', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'schedules/{id?}',
    handler: (request, context) => crudHandler(context, request, 'schedules'),
});

app.http('surveys', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'surveys/{id?}',
    handler: (request, context) => crudHandler(context, request, 'surveys'),
});

app.http('travel', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'travel/{id?}',
    handler: (request, context) => crudHandler(context, request, 'travel'),
});

app.http('time-off-requests', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'time-off-requests/{id?}',
    handler: async (request, context) => {
        let container;
        try {
            container = getContainer('time-off-requests');
        } catch (error) {
            context.log.error('Error getting time-off-requests container:', error);
            return {
                status: 500,
                jsonBody: { error: 'Database container error. Please ensure the time-off-requests container exists.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
        
        const { method } = request;
        const id = getIdFromRequest(request);

        try {
            switch (method) {
                case 'GET':
                    if (id) {
                        // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                        const { resource } = await container.item(id, id).read(); 
                        if (!resource) return { status: 404, jsonBody: { error: 'Time off request not found' } };
                        return { jsonBody: resource };
                    } else {
                        const { resources } = await container.items.readAll().fetchAll();
                        return { jsonBody: resources };
                    }
                
                case 'POST':
                    const body = await request.json();
                    
                    // Normalize date field - accept startDate if date is not provided
                    if (!body.date && body.startDate) {
                        body.date = body.startDate;
                    }
                    
                    validateTimeOffRequestsSchema(body);
                    
                    // Set default status to pending if not provided
                    const newRequest = { 
                        ...body,
                        date: body.date || body.startDate, // Ensure date is set
                        startDate: body.startDate || body.date, // Also include startDate for compatibility
                        endDate: body.endDate || body.date, // Use endDate if provided, otherwise use date
                        id: generateId(),
                        status: body.status || 'pending',
                        createdAt: new Date().toISOString(),
                        requestedBy: body.requestedBy || null,
                        approvedBy: null,
                        approvedAt: null
                    };
                    const { resource: createdRequest } = await container.items.create(newRequest);
                    return { status: 201, jsonBody: createdRequest };
                
                case 'PUT':
                    const requestBody = await request.json();
                    const updateId = id || requestBody.id;
                    validateTimeOffRequestsSchema(requestBody);
                    
                    // If status is being changed to approved, set approvedBy and approvedAt
                    if (requestBody.status === 'approved' && !requestBody.approvedBy) {
                        requestBody.approvedAt = new Date().toISOString();
                    }
                    
                    const updatedRequest = { ...requestBody, id: updateId };
                    const { resource: result } = await container.items.upsert(updatedRequest);
                    return { jsonBody: result };

                case 'DELETE':
                    if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                    try {
                        // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                        const { resource } = await container.item(id, id).read();
                        if (!resource) {
                            return { status: 204 };
                        }
                    } catch (e) {
                        return { status: 204 };
                    }
                    // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                    await container.item(id, id).delete();
                    return { status: 204 };

                case 'OPTIONS':
                    return { status: 200 };

                default:
                    return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
            }
        } catch (error) {
            return handleError(context, error, 'Time off requests operation failed');
        }
    },
});

// Register authenticate endpoint BEFORE users endpoint to ensure specific route matches first
// Register authenticate route BEFORE users route to ensure proper matching
// Register Entra ID authentication endpoint
app.http('usersAuthenticateEntra', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/authenticate-entra',
    handler: async (request, context) => {
        try {
            const { token } = await request.json();
            
            if (!token) {
                return {
                    status: 400,
                    jsonBody: { error: 'Token is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }

            // Validate token with Microsoft
            // For production, you should verify the JWT token signature
            // For now, we'll decode and extract user info
            try {
                const tokenParts = token.split('.');
                if (tokenParts.length !== 3) {
                    throw new Error('Invalid token format');
                }

                // Decode JWT payload (base64url)
                let base64 = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
                // Add padding if needed
                while (base64.length % 4) {
                    base64 += '=';
                }
                const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
                
                const entraId = payload.oid || payload.sub; // Object ID or Subject
                const email = payload.email || payload.upn || payload.preferred_username;
                const name = payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim();
                
                if (!entraId) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Invalid token: missing user identifier' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                let container;
                try {
                    container = getContainer('users');
                } catch (error) {
                    context.log.error('Error getting users container:', error);
                    return {
                        status: 500,
                        jsonBody: { error: 'Database error. Please check if users container exists.' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                // Look for existing user by Entra ID
                let users;
                try {
                    const { resources } = await container.items
                        .query({
                            query: "SELECT * FROM c WHERE c.entraId = @entraId",
                            parameters: [{ name: "@entraId", value: entraId }]
                        })
                        .fetchAll();
                    users = resources || [];
                } catch (error) {
                    context.log.error('Error querying users:', error);
                    return {
                        status: 500,
                        jsonBody: { error: 'Database error during authentication' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }

                let user;
                if (users.length > 0) {
                    // Existing user
                    user = users[0];
                    // Update user info if needed
                    const updates = {};
                    if (email && user.email !== email) updates.email = email;
                    if (name && user.name !== name) updates.name = name;
                    
                    if (Object.keys(updates).length > 0) {
                        const updatedUser = { ...user, ...updates };
                        const { resource } = await container.items.upsert(updatedUser);
                        user = resource;
                    }
                } else {
                    // Create new user from Entra ID
                    // Default permission level - you may want to check group membership
                    const newUser = {
                        id: generateId(),
                        entraId: entraId,
                        username: email || entraId,
                        email: email || '',
                        name: name || email || 'User',
                        permissionLevel: 'CRC', // Default permission level
                        createdAt: new Date().toISOString()
                    };
                    
                    const { resource: createdUser } = await container.items.create(newUser);
                    user = createdUser;
                }

                // Return user without sensitive data
                const { password: _, ...userWithoutPassword } = user;
                return { jsonBody: userWithoutPassword };
                
            } catch (decodeError) {
                context.log.error('Token decode error:', decodeError);
                return {
                    status: 400,
                    jsonBody: { error: 'Invalid token format' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
        } catch (error) {
            context.log.error('Entra ID authentication error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Authentication failed. Please try again.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    },
});

app.http('usersAuthenticate', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'users/authenticate',
    handler: async (request, context) => {
        try {
            const { username, password } = await request.json();
            
            if (!username || !password) {
                return {
                    status: 400,
                    jsonBody: { error: 'Username and password are required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            let container;
            try {
                container = getContainer('users');
            } catch (error) {
                context.log.error('Error getting users container:', error);
                return {
                    status: 500,
                    jsonBody: { error: 'Database error. Please check if users container exists.' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            let users;
            try {
                const { resources } = await container.items
                    .query({
                        query: "SELECT * FROM c WHERE c.username = @username",
                        parameters: [{ name: "@username", value: username }]
                    })
                    .fetchAll();
                users = resources || [];
            } catch (error) {
                context.log.error('Error querying users:', error);
                context.log.error('Error details:', {
                    message: error.message,
                    code: error.code,
                    statusCode: error.statusCode,
                    stack: error.stack
                });
                // If users container doesn't exist, return 401 (not 500) to indicate auth failure
                const errorMessage = (error.message || '').toLowerCase();
                if (errorMessage.includes('notfound') || 
                    errorMessage.includes('container') || 
                    errorMessage.includes('does not exist') ||
                    errorMessage.includes('not found')) {
                    return {
                        status: 401,
                        jsonBody: { error: 'Invalid username or password' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                // Return more detailed error for debugging
                return {
                    status: 500,
                    jsonBody: { 
                        error: 'Database error during authentication',
                        details: process.env.NODE_ENV === 'development' ? error.message : undefined
                    },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            if (users.length === 0) {
                return {
                    status: 401,
                    jsonBody: { error: 'Invalid username or password' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            const user = users[0];
            
            if (!verifyPassword(password, user.password)) {
                return {
                    status: 401,
                    jsonBody: { error: 'Invalid username or password' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Return user without password
            const { password: _, ...userWithoutPassword } = user;
            return { jsonBody: userWithoutPassword };
            
        } catch (error) {
            context.log.error('Authentication error:', error);
            return {
                status: 500,
                jsonBody: { error: 'Authentication failed. Please try again.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    },
});

// Register users list endpoint (no id parameter)
app.http('usersList', {
    methods: ['GET', 'POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users',
    handler: async (request, context) => {
        try {
            const container = getContainer('users');
            const { method } = request;
            
            if (method === 'GET') {
                const { resources } = await container.items.readAll().fetchAll();
                const usersWithoutPasswords = resources.map(({ password, ...user }) => user);
                return { jsonBody: usersWithoutPasswords };
            }
            
            if (method === 'POST') {
                const body = await request.json();
                validateUsersSchema(body);
                
                // Check if username already exists
                const { resources: existingUsers } = await container.items
                    .query({
                        query: "SELECT * FROM c WHERE c.username = @username",
                        parameters: [{ name: "@username", value: body.username }]
                    })
                    .fetchAll();
                
                if (existingUsers.length > 0) {
                    return {
                        status: 400,
                        jsonBody: { error: 'Username already exists' },
                        headers: { 'Content-Type': 'application/json' }
                    };
                }
                
                // Hash password
                const hashedPassword = hashPassword(body.password);
                const newUser = { 
                    ...body, 
                    id: generateId(),
                    password: hashedPassword,
                    createdAt: new Date().toISOString()
                };
                const { resource: createdUser } = await container.items.create(newUser);
                const { password: _, ...userWithoutPassword } = createdUser;
                return { status: 201, jsonBody: userWithoutPassword };
            }
            
            return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
        } catch (error) {
            return handleError(context, error, 'Users operation failed');
        }
    },
});

// Register users individual endpoint (with id parameter)
app.http('users', {
    methods: ['GET', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'users/{id}',
    handler: async (request, context) => {
        const container = getContainer('users');
        const { method } = request;
        const id = getIdFromRequest(request);
        
        // Explicitly exclude 'authenticate' from being handled by this route
        if (id === 'authenticate') {
            context.log.warn('Authenticate request matched users/{id} route - should use users/authenticate');
            return {
                status: 404,
                jsonBody: { error: 'Route not found. Use POST /api/users/authenticate for authentication.' },
                headers: { 'Content-Type': 'application/json' }
            };
        }

        try {
            switch (method) {
                case 'GET':
                    // Cosmos DB requires both id and partitionKey - in this case, id is the partition key
                    const { resource } = await container.item(id, id).read(); 
                    if (!resource) return { status: 404, jsonBody: { error: 'User not found' } };
                    // Don't return password hash
                    const { password: pwd, ...userWithoutPassword } = resource;
                    return { jsonBody: userWithoutPassword };
                
                case 'PUT':
                    const requestBody = await request.json();
                    const updateId = id || requestBody.id;
                    validateUsersSchema(requestBody);
                    
                    // If password is being updated, hash it
                    if (requestBody.password) {
                        requestBody.password = hashPassword(requestBody.password);
                    }
                    
                    const updatedUser = { ...requestBody, id: updateId };
                    const { resource: result } = await container.items.upsert(updatedUser);
                    const { password: pwd2, ...resultWithoutPassword } = result;
                    return { jsonBody: resultWithoutPassword };

                case 'DELETE':
                    if (!id) return { status: 400, jsonBody: { error: 'id is required' } };
                    try {
                        const { resource } = await container.item(id).read();
                        if (!resource) {
                            return { status: 204 };
                        }
                    } catch (e) {
                        return { status: 204 };
                    }
                    await container.item(id).delete();
                    return { status: 204 };

                case 'OPTIONS':
                    return { status: 200 };

                default:
                    return { status: 405, jsonBody: { error: 'Method Not Allowed' } };
            }
        } catch (error) {
            return handleError(context, error, 'Users operation failed');
        }
    },
});

// Initialize default admin user on first run
const initializeDefaultAdmin = async () => {
    try {
        const container = getContainer('users');
        const { resources: users } = await container.items
            .query({
                query: "SELECT * FROM c WHERE c.username = @username",
                parameters: [{ name: "@username", value: 'admin' }]
            })
            .fetchAll();
        
        if (users.length === 0) {
            const adminUser = {
                id: generateId(),
                username: 'admin',
                password: hashPassword('Password1!'),
                permissionLevel: 'Manager',
                email: '',
                entraId: '',
                createdAt: new Date().toISOString()
            };
            await container.items.create(adminUser);
            console.log('Default admin user created');
        }
    } catch (error) {
        console.error('Error initializing default admin user:', error);
    }
};

// Call initialization
initializeDefaultAdmin();

// Azure Maps key endpoint (for frontend to get key securely)
app.http('azure-maps-config', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'azure-maps-config',
    handler: async (request, context) => {
        try {
            const azureMapsKey = process.env.AZURE_MAPS_KEY || process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
            
            if (!azureMapsKey) {
                return {
                    status: 200,
                    jsonBody: {
                        error: 'Azure Maps key not configured. Please set AZURE_MAPS_KEY in Azure environment variables.',
                        key: null
                    },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            return {
                status: 200,
                jsonBody: {
                    key: azureMapsKey
                },
                headers: { 'Content-Type': 'application/json' }
            };
        } catch (error) {
            context.log.error('Error getting Azure Maps config:', error);
            return {
                status: 500,
                jsonBody: { error: 'Failed to get Azure Maps configuration' },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }
});

// Navan booking lookup endpoint
// This endpoint calls Navan API to get booking information by bookingId
// Step 1: Get OAuth token from https://api.navan.com/ta-auth/oauth/token
// Step 2: Call Navan Bookings API: https://api.navan.com/v1/bookings?createdFrom={timestamp}&createdTo={timestamp}
//        Then filter results by bookingId client-side
// Configure API credentials in Azure Static Web App environment variables:
// - NAVAN_CLIENT_ID: Set in Azure environment variables
// - NAVAN_SECRET_KEY: Set in Azure environment variables
app.http('navanLookup', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'navan-lookup',
    handler: async (request, context) => {
        // Handle OPTIONS request for CORS
        if (request.method === 'OPTIONS') {
            return {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            };
        }
        
        let bookingId = null;
        
        try {
            // Get query parameters - try multiple methods for compatibility
            if (request.query && request.query.bookingId) {
                bookingId = request.query.bookingId;
            } else if (request.query && typeof request.query.get === 'function') {
                bookingId = request.query.get('bookingId');
            } else if (request.url) {
                try {
                    // Try to parse as full URL
                    let urlString = request.url;
                    if (!urlString.startsWith('http')) {
                        // If relative, construct full URL
                        urlString = `https://${request.headers?.['host'] || 'localhost'}${urlString}`;
                    }
                    const url = new URL(urlString);
                    bookingId = url.searchParams.get('bookingId');
                } catch (error) {
                    context.log.warn('Error parsing URL:', error.message);
                    // Try simple query string parsing
                    const match = request.url.match(/[?&]bookingId=([^&]+)/);
                    if (match) {
                        bookingId = decodeURIComponent(match[1]);
                    }
                }
            }
            
            if (!bookingId) {
                context.log.error('Navan lookup: bookingId parameter missing. URL:', request.url);
                return {
                    status: 400,
                    jsonBody: { error: 'bookingId parameter is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Check if this is a read-only request (no database write)
            const readOnly = request.query?.readOnly === 'true' || 
                           (request.query && typeof request.query.get === 'function' && request.query.get('readOnly') === 'true') ||
                           (request.url && request.url.includes('readOnly=true'));
            
            context.log.info(`Navan booking lookup request for: ${bookingId} (readOnly: ${readOnly})`);
            
            // Step 1: Get OAuth token from Navan
            // Get Navan API credentials from environment variables (same pattern as Cosmos DB)
            const { clientId, clientSecret, source: navanCredentialSource } = resolveNavanCredentials(context);
            
            // Log credential status (without exposing values)
            context.log.info(`Navan credentials source: ${navanCredentialSource}`);
            context.log.info(`Navan credentials check: CLIENT_ID exists=${!!clientId}, SECRET_KEY exists=${!!clientSecret}`);
            
            if (!clientId || !clientSecret) {
                context.log.error('Navan credentials could not be resolved.');
                return {
                    status: 200, // Return 200 so frontend can see error details
                    jsonBody: {
                        error: 'Navan API credentials not configured.',
                        detail: 'No Navan credentials available from environment or hardcoded test configuration.',
                        originalMessage: 'Navan credentials check failed',
                        bookingId: bookingId
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            const fetchFn = await getFetch();
            const { baseUrl, authUrl } = resolveNavanEndpoints(context);
            context.log.info(`Navan endpoints resolved. Base URL: ${baseUrl}, Auth URL: ${authUrl}`);
            
            let accessToken;
            try {
                accessToken = await getNavanAuthToken(context, fetchFn, clientId, clientSecret);
            } catch (tokenError) {
                context.log.error('Failed to obtain Navan OAuth token:', tokenError);
                return {
                    status: 200, // Return 200 so frontend can see error details
                    jsonBody: {
                        error: 'Failed to get access token from Navan',
                        detail: tokenError.message || 'Unknown error requesting Navan token',
                        bookingId: bookingId
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            context.log.info('OAuth token obtained successfully');
            const sanitizedBaseUrl = baseUrl.replace(/\/$/, '');
            
            // Step 2: Get booking data from Navan
            // Strategy: First try to find booking by bookingId, then use its UUID for direct lookup
            context.log.info(`Fetching booking ${bookingId} from Navan...`);
            
            let bookingData = null;
            let bookingResponse = null;
            const navanRequestHeaders = {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'accept': 'application/json'
            };
            
            try {
                context.log.info('Attempting direct booking lookup using bookingUuid parameter');
                const directLookupUrl = `${sanitizedBaseUrl}/bookings?bookingUuid=${encodeURIComponent(bookingId)}&includeTransactions=false`;
                try {
                    const directResponse = await fetchFn(directLookupUrl, {
                        method: 'GET',
                        headers: navanRequestHeaders
                    });
                    if (directResponse.ok) {
                        const directData = await directResponse.json();
                        if (directData && Array.isArray(directData.data) && directData.data.length > 0) {
                            bookingData = { data: directData.data };
                            context.log.info('Booking retrieved via direct bookingUuid lookup');
                        } else {
                            context.log.info('Direct bookingUuid lookup returned no results');
                        }
                    } else {
                        const errorText = await directResponse.text().catch(() => 'Unable to read response body');
                        context.log.warn(`Direct bookingUuid lookup failed (${directResponse.status}): ${errorText}`);
                    }
                } catch (directError) {
                    context.log.warn(`Error during direct bookingUuid lookup: ${directError.message}`);
                }
                
                if (!bookingData) {
                    // First, fetch recent bookings to find the UUID for this bookingId
                    // Navan API requires createdFrom/createdTo parameters - fetch recent bookings (last 90 days)
                    const now = Date.now();
                    const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000);
                    const createdFrom = Math.floor(ninetyDaysAgo / 1000);
                    const createdTo = Math.floor(now / 1000);
                    
                    context.log.info(`Searching for bookingId ${bookingId} in bookings from ${new Date(ninetyDaysAgo).toISOString()} to ${new Date(now).toISOString()}`);
                    
                    // Fetch bookings with pagination - start with first page
                    let page = 0;
                    const pageSize = 100;
                    let foundBooking = null;
                    let bookingUuid = null;
                    
                    while (!foundBooking && page < 10) { // Limit to 10 pages (1000 bookings max)
                        context.log.info(`Fetching page ${page} of bookings to find bookingId...`);
                        
                        bookingResponse = await fetchFn(`${sanitizedBaseUrl}/bookings?createdFrom=${createdFrom}&createdTo=${createdTo}&page=${page}&size=${pageSize}&includeTransactions=false`, {
                            method: 'GET',
                            headers: navanRequestHeaders
                        });
                        
                        context.log.info(`Navan API response status: ${bookingResponse.status}`);
                        
                        if (!bookingResponse.ok) {
                            const errorText = await bookingResponse.text();
                            context.log.error(`Booking request failed: ${bookingResponse.status} - ${errorText}`);
                            return {
                                status: bookingResponse.status,
                                jsonBody: { 
                                    error: 'Failed to fetch bookings from Navan',
                                    bookingId: bookingId,
                                    details: errorText
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                        
                        const allBookings = await bookingResponse.json();
                        context.log.info(`Received ${allBookings.data?.length || 0} bookings on page ${page}`);
                        
                        // Find the booking by bookingId in the results
                        if (allBookings.data && Array.isArray(allBookings.data)) {
                            foundBooking = allBookings.data.find(b => b.bookingId === bookingId);
                            if (foundBooking) {
                                bookingUuid = foundBooking.uuid;
                                context.log.info(`Booking found on page ${page} with UUID: ${bookingUuid}`);
                                
                                // Now use the UUID to fetch the full booking details directly
                                // This is more efficient and ensures we get all details
                                context.log.info(`Fetching full booking details using UUID: ${bookingUuid}`);
                                const uuidResponse = await fetchFn(`${sanitizedBaseUrl}/bookings?bookingUuid=${bookingUuid}&includeTransactions=false`, {
                                    method: 'GET',
                                    headers: navanRequestHeaders
                                });
                                
                                if (uuidResponse.ok) {
                                    const uuidBookingData = await uuidResponse.json();
                                    if (uuidBookingData.data && uuidBookingData.data.length > 0) {
                                        bookingData = { data: [uuidBookingData.data[0]] };
                                        context.log.info('Full booking details retrieved using UUID');
                                        break;
                                    } else {
                                        // UUID lookup returned empty data, use booking from list
                                        context.log.warn('UUID lookup returned empty data, using booking from list');
                                        bookingData = { data: [foundBooking] };
                                        break;
                                    }
                                } else {
                                    // UUID lookup failed, use booking from list
                                    const errorText = await uuidResponse.text();
                                    context.log.warn(`UUID lookup failed with status ${uuidResponse.status}: ${errorText}`);
                                    context.log.warn('Falling back to booking from list');
                                    bookingData = { data: [foundBooking] };
                                    break;
                                }
                            }
                        }
                        
                        // Check if there are more pages
                        if (allBookings.page && allBookings.page.totalPages && page < allBookings.page.totalPages - 1) {
                            page++;
                        } else {
                            break; // No more pages
                        }
                    }
                    
                    if (!foundBooking) {
                        context.log.warn(`Booking ${bookingId} not found in recent bookings (searched ${page + 1} pages)`);
                        return {
                            status: 404,
                            jsonBody: {
                                error: 'Booking not found',
                                bookingId: bookingId,
                                message: 'Booking not found in recent bookings (last 90 days). The booking may be older or the bookingId may be incorrect.'
                            },
                            headers: { 'Content-Type': 'application/json' }
                        };
                    }
                }
            } catch (fetchError) {
                context.log.error('Error fetching booking from Navan:', fetchError.message);
                context.log.error('Fetch error stack:', fetchError.stack);
                throw fetchError;
            }
            
            // Verify bookingData is set
            if (!bookingData || !bookingData.data || bookingData.data.length === 0) {
                context.log.error('Booking data is null or empty after fetch');
                return {
                    status: 200, // Return 200 so frontend can see error details
                    jsonBody: { 
                        error: 'Booking not found',
                        detail: `No booking found with bookingId: ${bookingId}`,
                        bookingId: bookingId
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            // Step 3: Store booking data in travel container for reporting (skip if readOnly)
            if (readOnly) {
                context.log.info('Read-only mode: Skipping database write');
                // Return the booking data without storing it
                return {
                    status: 200,
                    jsonBody: {
                        data: bookingData.data,
                        readOnly: true,
                        message: 'Booking data retrieved successfully (read-only mode - not saved to database)'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            try {
                context.log.info('Attempting to get travel container...');
                const travelContainer = getContainer('travel');
                context.log.info('Travel container obtained successfully');
                
                // Check if a travel record already exists for this booking ID
                let existingTravel = null;
                try {
                    context.log.info(`Querying for existing travel record with navanBookingId: ${bookingId}`);
                    // Check for existing record by bookingId or UUID (in case it was previously stored with UUID)
                    // Get the booking UUID from the bookingData we just fetched
                    const bookingUuid = bookingData?.data?.[0]?.uuid || '';
                    
                    // Query for existing records - use IS_DEFINED to safely check if fields exist
                    // This prevents errors if navanBookingId or navanBookingUuid fields don't exist in old records
                    const { resources: existingRecords } = await travelContainer.items
                        .query({
                            query: "SELECT * FROM c WHERE (IS_DEFINED(c.navanBookingId) AND c.navanBookingId = @bookingId) OR (IS_DEFINED(c.navanBookingUuid) AND c.navanBookingUuid = @uuid)",
                            parameters: [
                                { name: "@bookingId", value: bookingId },
                                { name: "@uuid", value: bookingUuid }
                            ]
                        })
                        .fetchAll();
                    
                    context.log.info(`Found ${existingRecords?.length || 0} existing travel records`);
                    if (existingRecords && existingRecords.length > 0) {
                        existingTravel = existingRecords[0];
                        context.log.info('Existing travel record found, will update');
                    }
                } catch (queryError) {
                    context.log.warn('Error querying for existing travel record:', queryError.message);
                    context.log.warn('Query error stack:', queryError.stack);
                    // Continue to create new record if query fails
                }
                
                // Prepare travel record data from Navan booking
                // Transform Navan data to match existing travel container schema
                const booking = bookingData.data[0];
                const bookingType = booking.bookingType || 'FLIGHT';
                
                // Get passenger/traveler info and find matching CRC ID
                // Staff member should be pulled from passengers[0].person.name
                // Only use name for lookup (no email lookup)
                let crcId = null;
                let travelerName = null;
                
                if (booking.passengers && booking.passengers.length > 0 && booking.passengers[0].person) {
                    const person = booking.passengers[0].person;
                    travelerName = person.name || null; // Use name from passengers[0].person.name
                    
                    // Try to find CRC by name only (from passengers[0].person.name)
                    if (travelerName) {
                        try {
                            context.log.info(`Looking up CRC by name: ${travelerName}`);
                            const crcsContainer = getContainer('crcs');
                            const { resources: nameMatches } = await crcsContainer.items
                                .query({
                                    query: "SELECT * FROM c WHERE c.name = @name",
                                    parameters: [{ name: "@name", value: travelerName }]
                                })
                                .fetchAll();
                            
                            if (nameMatches && nameMatches.length > 0) {
                                crcId = nameMatches[0].id;
                                context.log.info(`Found matching CRC: ${crcId} for name ${travelerName}`);
                                    } else {
                                context.log.warn(`No CRC found with name: ${travelerName}`);
                            }
                        } catch (crcLookupError) {
                            context.log.warn('Error looking up CRC by name:', crcLookupError.message);
                            context.log.warn('CRC lookup error stack:', crcLookupError.stack);
                            // Continue without crcId - will need to be set manually
                        }
                    }
                }
                
                // If no CRC found, use name as fallback (from passengers[0].person.name)
                if (!crcId && travelerName) {
                    crcId = travelerName; // Temporary fallback
                    context.log.warn(`No CRC found for ${travelerName}, using name as crcId (will need manual update)`);
                }
                
                // Get date (required field: date) - format as YYYY-MM-DD string
                let date = null;
                if (booking.startDate) {
                    date = booking.startDate; // Already in YYYY-MM-DD format
                } else if (booking.segments && booking.segments.length > 0 && booking.segments[0].startLocalDateTime) {
                    // Extract date from ISO datetime string
                    const dateTime = new Date(booking.segments[0].startLocalDateTime);
                    date = dateTime.toISOString().split('T')[0]; // Extract YYYY-MM-DD
                }
                
                // Map Navan booking status to travel schema status
                const navanStatus = (booking.bookingStatus || booking.approvalStatus || 'CONFIRMED').toLowerCase();
                let status = 'scheduled'; // Default
                if (navanStatus.includes('confirmed') || navanStatus.includes('approved')) {
                    status = 'scheduled';
                } else if (navanStatus.includes('cancelled') || navanStatus.includes('canceled')) {
                    status = 'cancelled';
                } else if (navanStatus.includes('delayed')) {
                    status = 'delayed';
                } else if (navanStatus.includes('departed')) {
                    status = 'departed';
                } else if (navanStatus.includes('arrived') || navanStatus.includes('completed')) {
                    status = 'arrived';
                }
                
                // Map Navan booking to travel record format - ONLY fields that exist in travel schema
                const travelRecord = {
                    // Required fields for travel schema
                    crcId: crcId || 'unknown', // Required - use fallback if not found
                    date: date || new Date().toISOString().split('T')[0], // Required - use today if not available
                    
                    // Navan booking reference (optional field)
                    // Store the bookingId used for lookup, and also store UUID for reference
                    navanBookingId: bookingId, // The bookingId used to find this booking (e.g., "AQ8M5Q")
                    navanBookingUuid: booking.uuid || null, // The UUID from Navan (for reference)
                    
                    // Status (must be one of: scheduled, delayed, departed, arrived, cancelled)
                    status: status,
                    
                    // Confirmation number (common across all booking types)
                    confirmationNumber: booking.confirmationNumber || booking.bookingId || null
                };
                
                // Add booking-type specific fields based on actual Navan API structure
                if (bookingType === 'FLIGHT') {
                    // Flight-specific fields - map to existing travel schema
                    const segment = booking.segments && booking.segments.length > 0 ? booking.segments[0] : null;
                    if (segment?.flightNumber) {
                        travelRecord.flightNumber = String(segment.flightNumber);
                    }
                    if (segment?.departure?.airportCode) {
                        travelRecord.origin = String(segment.departure.airportCode);
                    }
                    if (segment?.arrival?.airportCode) {
                        travelRecord.destination = String(segment.arrival.airportCode);
                    }
                    // Map to flightCost if available (must be a number)
                    if (booking.grandTotal || booking.usdGrandTotal) {
                        const cost = booking.grandTotal || booking.usdGrandTotal;
                        travelRecord.flightCost = typeof cost === 'number' ? cost : parseFloat(cost);
                    }
                } else if (bookingType === 'HOTEL') {
                    // Hotel-specific fields - map to existing travel schema
                    // Based on actual Navan API structure:
                    // - segments[0].departure.address = "15520 Nw Gateway Ct" (hotel address)
                    // - segments[0].departure.city = "Beaverton" (hotel city)
                    // - segments[0].departure.state = "OR" (hotel state)
                    // - segments[0].departure.postalCode = "97006" (hotel postal code)
                    // - segments[0].departure.country = "US" (hotel country)
                    // - destination.city/state/country = fallback if segment data missing
                    const segment = booking.segments && booking.segments.length > 0 ? booking.segments[0] : null;
                    if (booking.vendor) {
                        travelRecord.hotelName = String(booking.vendor);
                    }
                    // Hotel address from segment departure
                    if (segment?.departure?.address) {
                        travelRecord.hotelAddress = String(segment.departure.address);
                    }
                    // Hotel city - prefer segment.departure.city (from Navan data)
                    if (segment?.departure?.city) {
                        travelRecord.hotelCity = String(segment.departure.city);
                    } else if (booking.destination?.city) {
                        travelRecord.hotelCity = String(booking.destination.city);
                    }
                    // Hotel state - prefer segment.departure.state
                    if (segment?.departure?.state) {
                        travelRecord.hotelState = String(segment.departure.state);
                    } else if (booking.destination?.state) {
                        travelRecord.hotelState = String(booking.destination.state);
                    }
                    // Hotel postal code
                    if (segment?.departure?.postalCode) {
                        travelRecord.hotelPostalCode = String(segment.departure.postalCode);
                    }
                    // Hotel country - prefer segment.departure.country
                    if (segment?.departure?.country) {
                        travelRecord.hotelCountry = String(segment.departure.country);
                    } else if (booking.destination?.country) {
                        travelRecord.hotelCountry = String(booking.destination.country);
                    }
                    // Check-in date - extract date from ISO datetime or use startDate
                    if (segment?.startLocalDateTime) {
                        const checkInDateTime = new Date(segment.startLocalDateTime);
                        travelRecord.checkIn = checkInDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
                    } else if (booking.startDate) {
                        travelRecord.checkIn = String(booking.startDate);
                    }
                    // Check-out date - extract date from ISO datetime or use endDate
                    if (segment?.endLocalDateTime) {
                        const checkOutDateTime = new Date(segment.endLocalDateTime);
                        travelRecord.checkOut = checkOutDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
                    } else if (booking.endDate) {
                        travelRecord.checkOut = String(booking.endDate);
                    }
                    // Map to hotelCost if available (must be a number)
                    if (booking.grandTotal || booking.usdGrandTotal) {
                        const cost = booking.grandTotal || booking.usdGrandTotal;
                        travelRecord.hotelCost = typeof cost === 'number' ? cost : parseFloat(cost);
                    }
                } else if (bookingType === 'CAR') {
                    // Car rental-specific fields - map to existing travel schema
                    // Based on actual Navan API structure:
                    // - segments[0].departure.address = "BNA-NASHVILLE" (pickup location)
                    // - segments[0].departure.airportCode = "BNA" (pickup airport)
                    // - origin.city/state = "Nashville", "Tennessee" (pickup city/state)
                    // - destination.city/state = same as origin for round-trip (dropoff city/state)
                    const segment = booking.segments && booking.segments.length > 0 ? booking.segments[0] : null;
                    if (booking.vendor) {
                        travelRecord.carRentalCompany = String(booking.vendor);
                    }
                    if (booking.carType) {
                        travelRecord.carType = String(booking.carType);
                    }
                    // Pickup location - use segment address (e.g., "BNA-NASHVILLE") or airport code
                    if (segment?.departure?.address) {
                        travelRecord.pickupLocation = String(segment.departure.address);
                    } else if (segment?.departure?.airportCode) {
                        travelRecord.pickupLocation = String(segment.departure.airportCode);
                    }
                    // Pickup city - prefer origin.city (from Navan data) since segment.departure.city is often null
                    if (booking.origin?.city) {
                        travelRecord.pickupCity = String(booking.origin.city);
                    } else if (segment?.departure?.city) {
                        travelRecord.pickupCity = String(segment.departure.city);
                    }
                    // Pickup state - prefer origin.state
                    if (booking.origin?.state) {
                        travelRecord.pickupState = String(booking.origin.state);
                    } else if (segment?.departure?.state) {
                        travelRecord.pickupState = String(segment.departure.state);
                    }
                    // Pickup airport code
                    if (segment?.departure?.airportCode) {
                        travelRecord.pickupAirportCode = String(segment.departure.airportCode);
                    }
                    // Dropoff location - use arrival address or same as departure for round-trip
                    if (segment?.arrival?.address) {
                        travelRecord.dropoffLocation = String(segment.arrival.address);
                    } else if (segment?.arrival?.airportCode) {
                        travelRecord.dropoffLocation = String(segment.arrival.airportCode);
                    } else if (segment?.departure?.address) {
                        travelRecord.dropoffLocation = String(segment.departure.address);
                    } else if (segment?.departure?.airportCode) {
                        travelRecord.dropoffLocation = String(segment.departure.airportCode);
                    }
                    // Dropoff city - prefer destination.city
                    if (booking.destination?.city) {
                        travelRecord.dropoffCity = String(booking.destination.city);
                    } else if (segment?.arrival?.city) {
                        travelRecord.dropoffCity = String(segment.arrival.city);
                    } else if (booking.origin?.city) {
                        // Round-trip: use origin city as fallback
                        travelRecord.dropoffCity = String(booking.origin.city);
                    }
                    // Dropoff state - prefer destination.state
                    if (booking.destination?.state) {
                        travelRecord.dropoffState = String(booking.destination.state);
                    } else if (segment?.arrival?.state) {
                        travelRecord.dropoffState = String(segment.arrival.state);
                    } else if (booking.origin?.state) {
                        // Round-trip: use origin state as fallback
                        travelRecord.dropoffState = String(booking.origin.state);
                    }
                    // Dropoff airport code
                    if (segment?.arrival?.airportCode) {
                        travelRecord.dropoffAirportCode = String(segment.arrival.airportCode);
                    } else if (segment?.departure?.airportCode) {
                        // Round-trip: use departure airport code
                        travelRecord.dropoffAirportCode = String(segment.departure.airportCode);
                    }
                    // Pickup date - extract date from ISO datetime or use startDate
                    if (segment?.startLocalDateTime) {
                        const pickupDateTime = new Date(segment.startLocalDateTime);
                        travelRecord.pickupDate = pickupDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
                    } else if (booking.startDate) {
                        travelRecord.pickupDate = String(booking.startDate);
                    }
                    // Dropoff date - extract date from ISO datetime or use endDate
                    if (segment?.endLocalDateTime) {
                        const dropoffDateTime = new Date(segment.endLocalDateTime);
                        travelRecord.dropoffDate = dropoffDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
                    } else if (booking.endDate) {
                        travelRecord.dropoffDate = String(booking.endDate);
                    }
                    // Map to carRentalCost if available (must be a number)
                    if (booking.grandTotal || booking.usdGrandTotal) {
                        const cost = booking.grandTotal || booking.usdGrandTotal;
                        travelRecord.carRentalCost = typeof cost === 'number' ? cost : parseFloat(cost);
                    }
                }
                
                // Additional optional fields that match existing schema
                if (booking.reason) {
                    travelRecord.reason = String(booking.reason);
                }
                
                // Remove null/undefined/empty values to keep record clean
                // But keep confirmationNumber even if null (it's a common field)
                Object.keys(travelRecord).forEach(key => {
                    if (key === 'confirmationNumber') {
                        // Keep confirmationNumber even if null - it's a common field
                        return;
                    }
                    if (travelRecord[key] === null || travelRecord[key] === undefined || travelRecord[key] === '') {
                        delete travelRecord[key];
                    }
                });
                
                // Ensure required fields are present
                if (!travelRecord.crcId || travelRecord.crcId === 'unknown') {
                    context.log.warn(`Warning: crcId is missing or unknown for booking ${bookingId}`);
                }
                if (!travelRecord.date) {
                    context.log.warn(`Warning: date is missing for booking ${bookingId}`);
                }
                
                if (existingTravel) {
                    // Update existing travel record
                    context.log.info('Updating existing travel record...');
                    const updatedTravel = { ...existingTravel, ...travelRecord, id: existingTravel.id };
                    try {
                        const { resource: savedTravel } = await travelContainer.items.upsert(updatedTravel);
                        context.log.info(`Updated existing travel record for Navan booking ${bookingId}`);
                    } catch (upsertError) {
                        context.log.error('Error upserting travel record:', upsertError.message);
                        context.log.error('Upsert error stack:', upsertError.stack);
                        context.log.error('Upsert error details:', JSON.stringify(upsertError, Object.getOwnPropertyNames(upsertError)));
                        throw upsertError; // Re-throw to be caught by outer catch
                    }
                } else {
                    // Create new travel record
                    context.log.info('Creating new travel record...');
                    const newTravel = { ...travelRecord, id: generateId() };
                    context.log.info('Travel record data prepared:', JSON.stringify(newTravel, null, 2));
                    try {
                        const { resource: savedTravel } = await travelContainer.items.create(newTravel);
                        context.log.info(`Created new travel record for Navan booking ${bookingId}`);
                    } catch (createError) {
                        context.log.error('Error creating travel record:', createError.message);
                        context.log.error('Create error stack:', createError.stack);
                        context.log.error('Create error details:', JSON.stringify(createError, Object.getOwnPropertyNames(createError)));
                        context.log.error('Travel record that failed to create:', JSON.stringify(newTravel, null, 2));
                        throw createError; // Re-throw to be caught by outer catch
                    }
                }
            } catch (storageError) {
                context.log.error('Error storing booking data in travel container:', storageError.message);
                context.log.error('Storage error stack:', storageError.stack);
                context.log.error('Storage error details:', JSON.stringify(storageError, Object.getOwnPropertyNames(storageError)));
                
                // Return booking data even if storage fails, but include error details
                // This allows the lookup to succeed even if storage fails
                            return {
                                status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    jsonBody: {
                        ...bookingData,
                        storageError: {
                            message: storageError.message,
                            detail: `Failed to store booking in travel container: ${storageError.message}`,
                            stack: storageError.stack
                        }
                    }
                };
            }
            
            // Return the booking data
            return {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                jsonBody: bookingData
            };
            
        } catch (error) {
            context.log.error('Navan lookup error:', error.message);
            context.log.error('Error stack:', error.stack);
            context.log.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            
            return {
                status: 200, // Return 200 so frontend can see error details
                jsonBody: { 
                    error: 'Navan lookup failed',
                    detail: error.message || 'Unknown error occurred',
                    stack: error.stack || 'No stack trace available',
                    originalMessage: 'Navan lookup exception',
                    bookingId: bookingId || null
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
        }
    },
});

// Navan API connection test endpoint
// Tests OAuth token generation to verify Navan API connectivity
app.http('navanTest', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'navan-test',
    handler: async (request, context) => {
        // Wrap everything in a try-catch to ensure we always return a response
        try {
            // Default error response
            const errorResponse = (error, detail) => ({
                status: 200, // Always return 200 so frontend can see error details
                jsonBody: {
                    connected: false,
                    error: error || 'Connection test failed',
                    detail: detail || 'Unknown error occurred',
                    message: 'Failed to test Navan API connection'
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
            
            // Handle OPTIONS request for CORS
            if (request.method === 'OPTIONS') {
                return {
                    status: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }
                };
            }
            
            try {
                context.log.info('Navan API connection test requested');
            
            // Get Navan API credentials from environment variables
            let clientId, clientSecret, navanCredentialSource;
            try {
                ({ clientId, clientSecret, source: navanCredentialSource } = resolveNavanCredentials(context));
            } catch (envError) {
                context.log.error('Error resolving Navan credentials:', envError);
                return errorResponse('Navan credential resolution error', envError.message);
            }
            
            context.log.info(`Navan credentials source: ${navanCredentialSource}`);
            context.log.info(`Navan credentials check: CLIENT_ID exists=${!!clientId}, SECRET_KEY exists=${!!clientSecret}`);
            
            // Check if credentials are available
            if (!clientId || !clientSecret) {
                context.log.error('Navan credentials not configured');
                return {
                    status: 200, // Return 200 so frontend can see the error details
                    jsonBody: {
                        connected: false,
                        error: 'Navan API credentials not configured',
                        detail: 'No Navan credentials available from environment or hardcoded test configuration.',
                        message: 'Please set NAVAN_CLIENT_ID and NAVAN_SECRET_KEY in Azure environment variables'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            const fetchFn = await getFetch();
            const { baseUrl } = resolveNavanEndpoints(context);
            const sanitizedBaseUrl = baseUrl.replace(/\/$/, '');
            
            let accessToken;
            try {
                accessToken = await getNavanAuthToken(context, fetchFn, clientId, clientSecret);
                context.log.info('Navan OAuth token generated successfully for connectivity test');
            } catch (tokenError) {
                context.log.error('Navan OAuth token generation failed during test:', tokenError);
                return errorResponse('Failed to generate OAuth token', tokenError.message);
            }
            
            // Test a simple API call to verify the token works
            context.log.info('Testing API call with token...');
            let testApiResponse;
            try {
                testApiResponse = await fetchFn(`${sanitizedBaseUrl}/bookings?page=0&size=1&includeTransactions=false`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'accept': 'application/json'
                    }
                });
            } catch (fetchError) {
                context.log.error('Fetch error during API test call:', fetchError);
                return {
                    status: 200,
                    jsonBody: {
                        connected: true,
                        oauthToken: true,
                        apiCall: false,
                        error: 'Network error during API call',
                        detail: fetchError.message,
                        message: 'OAuth token generated but API call failed due to network error.'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            if (!testApiResponse.ok) {
                const errorText = await testApiResponse.text();
                context.log.warn(`API test call failed: ${testApiResponse.status} - ${errorText}`);
                return {
                    status: 200,
                    jsonBody: {
                        connected: true,
                        oauthToken: true,
                        apiCall: false,
                        error: 'OAuth token generated but API call failed',
                        detail: `API call failed with status ${testApiResponse.status}: ${errorText}`,
                        message: 'Connected to Navan OAuth but API call failed. This may be normal if there are no recent bookings.'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            }
            
            context.log.info('Navan API connection test successful');
            return {
                status: 200,
                jsonBody: {
                    connected: true,
                    oauthToken: true,
                    apiCall: true,
                    message: 'Successfully connected to Navan API'
                },
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            };
            
            } catch (error) {
                context.log.error('Navan connection test error:', error.message);
                context.log.error('Error stack:', error.stack);
                try {
                    context.log.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
                } catch (stringifyError) {
                    context.log.error('Could not stringify error object:', stringifyError);
                }
                
                // Ensure we always return a valid response, even if there's an error
                try {
                    return {
                        status: 200, // Return 200 so frontend can see the error details
                        jsonBody: {
                            connected: false,
                            error: 'Connection test failed',
                            detail: error?.message || error?.toString() || 'Unknown error occurred',
                            stack: error?.stack || 'No stack trace available',
                            message: 'Failed to test Navan API connection'
                        },
                        headers: { 
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        }
                    };
                } catch (responseError) {
                    // If even creating the response fails, log it and return minimal response
                    context.log.error('Error creating error response:', responseError);
                    try {
                        return {
                            status: 200,
                            jsonBody: {
                                connected: false,
                                error: 'Critical error',
                                detail: 'An unexpected error occurred while processing the request',
                                message: 'Failed to test Navan API connection'
                            },
                            headers: { 
                                'Content-Type': 'application/json',
                                'Access-Control-Allow-Origin': '*'
                            }
                        };
                    } catch (finalError) {
                        // Last resort - return a simple response
                        context.log.error('Final error in error handler:', finalError);
                        return {
                            status: 200,
                            jsonBody: { connected: false, error: 'Critical error', message: 'Failed to test Navan API connection' },
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                        };
                    }
                }
            }
        } catch (outerError) {
            // Catch any errors that occur outside the main try-catch (e.g., in errorResponse function)
            try {
                context.log.error('Outer error in navanTest handler:', outerError);
                return {
                    status: 200,
                    jsonBody: {
                        connected: false,
                        error: 'Handler initialization error',
                        detail: outerError?.message || outerError?.toString() || 'Unknown error',
                        message: 'Failed to initialize Navan API connection test'
                    },
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                };
            } catch (lastError) {
                // Absolute last resort
                context.log.error('Complete failure in navanTest handler:', lastError);
                return {
                    status: 200,
                    jsonBody: { connected: false, error: 'Complete failure', message: 'Failed to test Navan API connection' },
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                };
            }
        }
    },
});

// Azure Maps Geocoding Proxy
app.http('geocode', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'geocode',
    handler: async (request, context) => {
        try {
            const azureMapsKey = process.env.AZURE_MAPS_KEY || process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
            if (!azureMapsKey) {
                return {
                    status: 500,
                    jsonBody: { error: 'Azure Maps key not configured' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Get query parameters from the original request
            let queryParams = '';
            if (request.url) {
                try {
                    // Extract query string from URL
                    let urlString = request.url;
                    if (!urlString.startsWith('http')) {
                        // Construct full URL if relative
                        const host = request.headers?.['host'] || request.headers?.['x-forwarded-host'] || 'localhost';
                        urlString = `https://${host}${urlString}`;
                    }
                    const url = new URL(urlString);
                    queryParams = url.search; // This includes the leading ?
                } catch (error) {
                    context.log.warn('Error parsing URL for geocode:', error.message);
                    // Fallback: extract query string manually
                    const match = request.url.match(/\?(.+)/);
                    if (match) {
                        queryParams = '?' + match[1];
                    } else {
                        queryParams = '';
                    }
                }
            }
            
            // Build the Azure Maps API URL - pass all query params and add subscription-key
            const apiUrl = `https://atlas.microsoft.com/search/address/json${queryParams ? queryParams + '&' : '?'}subscription-key=${azureMapsKey}`;
            
            try {
                const fetchFn = await getFetch();
                const response = await fetchFn(apiUrl);
                const data = await response.json();
                return {
                    status: 200,
                    jsonBody: data,
                    headers: { 'Content-Type': 'application/json' }
                };
            } catch (error) {
                context.log.error('Azure Maps geocoding error:', error.message);
                return {
                    status: 500,
                    jsonBody: { error: error.message },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
        } catch (error) {
            context.log.error('Geocode endpoint error:', error.message);
            return {
                status: 500,
                jsonBody: { error: error.message },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }
});

// Azure Maps Route Directions Proxy
app.http('routeDirections', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'route/directions',
    handler: async (request, context) => {
        try {
            const azureMapsKey = process.env.AZURE_MAPS_KEY || process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
            if (!azureMapsKey) {
                return {
                    status: 500,
                    jsonBody: { error: 'Azure Maps key not configured' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Get query parameters from the original request
            let queryParams = '';
            if (request.url) {
                try {
                    // Extract query string from URL
                    let urlString = request.url;
                    if (!urlString.startsWith('http')) {
                        // Construct full URL if relative
                        const host = request.headers?.['host'] || request.headers?.['x-forwarded-host'] || 'localhost';
                        urlString = `https://${host}${urlString}`;
                    }
                    const url = new URL(urlString);
                    queryParams = url.search; // This includes the leading ?
                } catch (error) {
                    context.log.warn('Error parsing URL for route directions:', error.message);
                    // Fallback: extract query string manually
                    const match = request.url.match(/\?(.+)/);
                    if (match) {
                        queryParams = '?' + match[1];
                    } else {
                        queryParams = '';
                    }
                }
            }
            
            // Build the Azure Maps API URL - pass all query params and add subscription-key
            const apiUrl = `https://atlas.microsoft.com/route/directions/json${queryParams ? queryParams + '&' : '?'}subscription-key=${azureMapsKey}`;
            
            try {
                const fetchFn = await getFetch();
                const response = await fetchFn(apiUrl);
                const data = await response.json();
                return {
                    status: 200,
                    jsonBody: data,
                    headers: { 'Content-Type': 'application/json' }
                };
            } catch (error) {
                context.log.error('Azure Maps route directions error:', error.message);
                return {
                    status: 500,
                    jsonBody: { error: error.message },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
        } catch (error) {
            context.log.error('Route directions endpoint error:', error.message);
            return {
                status: 500,
                jsonBody: { error: error.message },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    }
});
