const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

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
    if (error.message.includes('COSMOS_DB_CONFIG_MISSING')) {
        errorMessage = "API Configuration Error: Database secrets not set in Azure Configuration.";
    } else if (error.message.includes('VALIDATION_ERROR')) {
        errorMessage = error.message.replace('VALIDATION_ERROR: ', '');
    } else {
        errorMessage = "Internal Server Error during data processing.";
    }

    return {
        status: 500,
        jsonBody: { error: errorMessage },
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
                        const { resource } = await container.item(id).read(); 
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
                    const { resource } = await container.item(id).read();
                    if (!resource) {
                        // Treat missing as already deleted
                        return { status: 204 };
                    }
                } catch (e) {
                    // If read fails (e.g., not found), return 204 for idempotency
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
                        const { resource } = await container.item(id).read(); 
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
                    const { resource } = await container.item(id).read(); 
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

// Flight lookup proxy endpoint
app.http('flightLookup', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'flight-lookup',
    handler: async (request, context) => {
        let flightNumber = null;
        
        // Wrap everything in try-catch to ensure we always return 200 instead of 500
        try {
            // Get query parameters from request URL
            if (request.url) {
                try {
                    const url = new URL(request.url);
                    flightNumber = url.searchParams.get('flightNumber');
                } catch (error) {
                    context.log.warn('Error parsing URL:', error.message);
                }
            }
            // Fallback: try request.query if available
            if (!flightNumber && request.query) {
                flightNumber = request.query.flightNumber || request.query.get?.('flightNumber');
            }
            
            if (!flightNumber) {
                context.log.error('Flight lookup: flightNumber parameter missing. URL:', request.url);
                return {
                    status: 400,
                    jsonBody: { error: 'flightNumber parameter is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            context.log.info(`Flight lookup request for: ${flightNumber}`);
            
            // Try AviationStack API (available via Microsoft Connectors)
            const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_API_KEY;
            context.log.info(`AviationStack API check: Key exists=${!!AVIATIONSTACK_KEY}`);
            
            // If no API key, return basic info immediately
            if (!AVIATIONSTACK_KEY) {
                context.log.info('AviationStack API key not configured, returning basic info');
                return {
                    status: 200,
                    jsonBody: {
                        flightNumber: flightNumber,
                        airline: null,
                        origin: null,
                        destination: null,
                        departureTime: null,
                        arrivalTime: null,
                        status: 'scheduled',
                        delay: null,
                        gate: null,
                        terminal: null,
                        message: 'Flight API key not configured. Please configure AVIATIONSTACK_API_KEY in Azure environment variables for full flight information.'
                    },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            if (AVIATIONSTACK_KEY) {
                try {
                    context.log.info(`Calling AviationStack API for flight: ${flightNumber}`);
                    
                    // Try multiple API parameter formats based on AviationStack documentation
                    // Format 1: flight_iata (full IATA code like DAL1478)
                    let apiUrl = `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&flight_iata=${encodeURIComponent(flightNumber.toUpperCase())}&limit=100`;
                    let response;
                    let apiData = null;
                    
                    try {
                        response = await fetch(apiUrl);
                        context.log.info(`AviationStack API response status (flight_iata): ${response.status}`);
                    } catch (fetchError) {
                        context.log.error('AviationStack API fetch error:', fetchError.message);
                        // Fall through to return basic info
                        response = null;
                    }
                    
                    if (response && response.ok) {
                        try {
                            apiData = await response.json();
                            context.log.info(`AviationStack API response: ${apiData.data?.length || 0} flights found`);
                        } catch (jsonError) {
                            context.log.error('AviationStack API JSON parse error:', jsonError.message);
                            // Fall through to try alternative method
                            apiData = null;
                        }
                    }
                    
                    if (apiData && apiData.data && apiData.data.length > 0) {
                        const exactMatch = apiData.data.find(f => 
                            f.flight?.iata?.toUpperCase() === flightNumber.toUpperCase() ||
                            f.flight?.number?.toString() === flightNumber.replace(/^[A-Z]{2,3}/i, '')
                        );
                        
                        if (exactMatch) {
                            const flight = exactMatch;
                            context.log.info(`Flight found: ${flight.flight?.iata || flight.flight?.number}, Origin: ${flight.departure?.iata || flight.departure?.airport}, Dest: ${flight.arrival?.iata || flight.arrival?.airport}`);
                            
                            return {
                                jsonBody: {
                                    flightNumber: flight.flight?.iata || flight.flight?.number || flightNumber,
                                    airline: flight.airline?.name || flight.airline?.iata || null,
                                    origin: flight.departure?.iata || flight.departure?.airport || flight.departure?.airport_name || null,
                                    destination: flight.arrival?.iata || flight.arrival?.airport || flight.arrival?.airport_name || null,
                                    departureTime: flight.departure?.scheduled || flight.departure?.estimated || null,
                                    arrivalTime: flight.arrival?.scheduled || flight.arrival?.estimated || null,
                                    status: flight.flight_status || 'scheduled',
                                    delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : (flight.arrival?.delay ? `${flight.arrival.delay} minutes` : null),
                                    gate: flight.departure?.gate || flight.arrival?.gate || null,
                                    terminal: flight.departure?.terminal || flight.arrival?.terminal || null
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    } else if (response && !response.ok) {
                        const errorText = await response.text();
                        context.log.error(`AviationStack API error: ${response.status} - ${errorText.substring(0, 200)}`);
                    }
                    
                    // If not found with flight_iata, try splitting into airline_iata + flight_number
                    if (!apiData || !apiData.data || apiData.data.length === 0) {
                        context.log.info('Trying airline_iata + flight_number parameter format');
                        const flightMatch = flightNumber.match(/^([A-Z]{2,3})(\d+)$/i);
                        if (flightMatch) {
                            const [, airlineCode, flightNum] = flightMatch;
                            apiUrl = `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&airline_iata=${airlineCode.toUpperCase()}&flight_number=${flightNum}&limit=100`;
                            
                            try {
                                response = await fetch(apiUrl);
                                context.log.info(`AviationStack API response status (airline_iata+flight_number): ${response.status}`);
                            } catch (fetchError) {
                                context.log.error('AviationStack API fetch error (alternative):', fetchError.message);
                                response = null;
                            }
                            
                            if (response && response.ok) {
                                try {
                                    apiData = await response.json();
                                    context.log.info(`AviationStack API response: ${apiData.data?.length || 0} flights found`);
                                } catch (jsonError) {
                                    context.log.error('AviationStack API JSON parse error (alternative):', jsonError.message);
                                    apiData = null;
                                }
                            }
                            
                            if (apiData && apiData.data && apiData.data.length > 0) {
                                // Find the best match
                                const bestMatch = apiData.data.find(f => 
                                    f.flight?.iata?.toUpperCase() === flightNumber.toUpperCase() ||
                                    (f.airline?.iata?.toUpperCase() === airlineCode.toUpperCase() && 
                                     f.flight?.number?.toString() === flightNum)
                                ) || apiData.data[0];
                                
                                const flight = bestMatch;
                                context.log.info(`Flight found: ${flight.flight?.iata || flight.flight?.number}, Origin: ${flight.departure?.iata || flight.departure?.airport}, Dest: ${flight.arrival?.iata || flight.arrival?.airport}`);
                                
                                return {
                                    jsonBody: {
                                        flightNumber: flight.flight?.iata || flight.flight?.number || flightNumber,
                                        airline: flight.airline?.name || flight.airline?.iata || null,
                                        origin: flight.departure?.iata || flight.departure?.airport || flight.departure?.airport_name || null,
                                        destination: flight.arrival?.iata || flight.arrival?.airport || flight.arrival?.airport_name || null,
                                        departureTime: flight.departure?.scheduled || flight.departure?.estimated || null,
                                        arrivalTime: flight.arrival?.scheduled || flight.arrival?.estimated || null,
                                        status: flight.flight_status || 'scheduled',
                                        delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : (flight.arrival?.delay ? `${flight.arrival.delay} minutes` : null),
                                        gate: flight.departure?.gate || flight.arrival?.gate || null,
                                        terminal: flight.departure?.terminal || flight.arrival?.terminal || null
                                    },
                                    headers: { 'Content-Type': 'application/json' }
                                };
                            } else if (response && !response.ok) {
                                const errorText = await response.text();
                                context.log.error(`AviationStack API error (alternative): ${response.status} - ${errorText.substring(0, 200)}`);
                            }
                        }
                    }
                } catch (error) {
                    context.log.error('AviationStack API exception:', error.message);
                    context.log.error('Stack:', error.stack);
                    // Don't throw, fall through to return basic info
                }
            } else {
                context.log.info('AviationStack API key not configured');
            }
            
            // Try OAG Flight Info API via Azure Marketplace (if configured, as fallback)
            const OAG_API_KEY = process.env.OAG_API_KEY || process.env.OAG_FLIGHT_INFO_API_KEY;
            const OAG_API_URL = process.env.OAG_API_URL || 'https://api.oag.com/flightinfo/v1';
            if (OAG_API_KEY && !AVIATIONSTACK_KEY) {
                try {
                    // OAG API format - adjust based on their actual API documentation
                    const response = await fetch(`${OAG_API_URL}/flights?flightNumber=${flightNumber}`, {
                        headers: {
                            'Authorization': `Bearer ${OAG_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    if (response.ok) {
                        const apiData = await response.json();
                        // Adjust response parsing based on OAG API structure
                        if (apiData.data && apiData.data.length > 0) {
                            const flight = apiData.data[0];
                            return {
                                jsonBody: {
                                    flightNumber: flight.flightNumber || flightNumber,
                                    airline: flight.airline?.name || null,
                                    origin: flight.origin?.airport || flight.origin?.iata || null,
                                    destination: flight.destination?.airport || flight.destination?.iata || null,
                                    departureTime: flight.departure?.scheduled || null,
                                    arrivalTime: flight.arrival?.scheduled || null,
                                    status: flight.status || 'scheduled',
                                    delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : null,
                                    gate: flight.departure?.gate || null,
                                    terminal: flight.departure?.terminal || null
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    }
                } catch (error) {
                    context.log.warn('OAG API failed:', error.message);
                }
            }
            
            // If no API key configured or API call failed, return basic info with 200 status
            // This allows the frontend to handle it gracefully
            return {
                status: 200,
                jsonBody: {
                    flightNumber: flightNumber,
                    airline: null,
                    origin: null,
                    destination: null,
                    departureTime: null,
                    arrivalTime: null,
                    status: 'scheduled',
                    delay: null,
                    gate: null,
                    terminal: null,
                    message: AVIATIONSTACK_KEY 
                        ? 'Flight information not available. The flight may not be in the system or the API returned no data.'
                        : 'Flight API key not configured. Please configure AVIATIONSTACK_API_KEY in Azure environment variables for full flight information.'
                },
                headers: { 'Content-Type': 'application/json' }
            };
            
        } catch (error) {
            context.log.error('Flight lookup error:', error.message, error.stack);
            // Return 200 with error info instead of 500 so frontend can handle it
            return {
                status: 200,
                jsonBody: { 
                    flightNumber: flightNumber || 'unknown',
                    airline: null,
                    origin: null,
                    destination: null,
                    departureTime: null,
                    arrivalTime: null,
                    status: 'scheduled',
                    delay: null,
                    gate: null,
                    terminal: null,
                    message: `Flight lookup failed: ${error.message}. Please enter flight details manually.`
                },
                headers: { 'Content-Type': 'application/json' }
            };
        }
    },
});
