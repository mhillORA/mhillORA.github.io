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
    
    if (data.flightCost !== undefined && (typeof data.flightCost !== 'number' || data.flightCost < 0)) {
        errors.push('flightCost must be a non-negative number');
    }
    
    if (data.carRentalCost !== undefined && (typeof data.carRentalCost !== 'number' || data.carRentalCost < 0)) {
        errors.push('carRentalCost must be a non-negative number');
    }
    
    if (data.hotelCost !== undefined && (typeof data.hotelCost !== 'number' || data.hotelCost < 0)) {
        errors.push('hotelCost must be a non-negative number');
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
    const container = getContainer(containerName);
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
                        if (error.code === 404 || error.message.includes('NotFound') || error.message.includes('Container')) {
                            context.log.warn(`Container '${containerName}' does not exist yet, returning empty array`);
                            return { jsonBody: [] };
                        }
                        throw error;
                    }
                }
            
            case 'POST':
                const body = await request.json();
                
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
        const container = getContainer('time-off-requests');
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
                    validateTimeOffRequestsSchema(body);
                    
                    // Set default status to pending if not provided
                    const newRequest = { 
                        ...body, 
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

app.http('users', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous', 
    route: 'users/{id?}',
    handler: async (request, context) => {
        const container = getContainer('users');
        const { method } = request;
        const id = getIdFromRequest(request);

        try {
            switch (method) {
                case 'GET':
                    if (id) {
                        const { resource } = await container.item(id).read(); 
                        if (!resource) return { status: 404, jsonBody: { error: 'User not found' } };
                        // Don't return password hash
                        const { password, ...userWithoutPassword } = resource;
                        return { jsonBody: userWithoutPassword };
                    } else {
                        const { resources } = await container.items.readAll().fetchAll();
                        // Remove password hashes from all users
                        const usersWithoutPasswords = resources.map(({ password, ...user }) => user);
                        return { jsonBody: usersWithoutPasswords };
                    }
                
                case 'POST':
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
                    const { password: __, ...resultWithoutPassword } = result;
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
            
            const container = getContainer('users');
            const { resources: users } = await container.items
                .query({
                    query: "SELECT * FROM c WHERE c.username = @username",
                    parameters: [{ name: "@username", value: username }]
                })
                .fetchAll();
            
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
            return handleError(context, error, 'Authentication failed');
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

// Flight lookup proxy endpoint
app.http('flightLookup', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'flight-lookup',
    handler: async (request, context) => {
        try {
            const { searchParams } = new URL(request.url);
            const flightNumber = searchParams.get('flightNumber');
            
            if (!flightNumber) {
                return {
                    status: 400,
                    jsonBody: { error: 'flightNumber parameter is required' },
                    headers: { 'Content-Type': 'application/json' }
                };
            }
            
            // Try FlightLabs API first (if API key is configured)
            const FLIGHT_API_KEY = process.env.FLIGHT_API_KEY || process.env.FLIGHTLABS_API_KEY;
            const FLIGHT_API_PROVIDER = process.env.FLIGHT_API_PROVIDER || 'flightlabs';
            
            if (FLIGHT_API_KEY && FLIGHT_API_PROVIDER === 'flightlabs') {
                try {
                    const response = await fetch(`https://app.goflightlabs.com/flights?access_key=${FLIGHT_API_KEY}&flight_iata=${flightNumber}`);
                    if (response.ok) {
                        const apiData = await response.json();
                        if (apiData.data && apiData.data.length > 0) {
                            const flight = apiData.data[0];
                            return {
                                jsonBody: {
                                    flightNumber: flight.flight?.iata || flightNumber,
                                    airline: flight.airline?.name || null,
                                    origin: flight.departure?.airport || flight.departure?.iata || null,
                                    destination: flight.arrival?.airport || flight.arrival?.iata || null,
                                    departureTime: flight.departure?.scheduled || null,
                                    arrivalTime: flight.arrival?.scheduled || null,
                                    status: flight.flight_status || 'scheduled',
                                    delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : null,
                                    gate: flight.departure?.gate || null,
                                    terminal: flight.departure?.terminal || null
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    }
                } catch (error) {
                    context.log.warn('FlightLabs API failed:', error.message);
                }
            }
            
            // Try AviationStack API if configured
            const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_API_KEY;
            if (AVIATIONSTACK_KEY && (!FLIGHT_API_KEY || FLIGHT_API_PROVIDER === 'aviationstack')) {
                try {
                    const response = await fetch(`http://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&flight_iata=${flightNumber}&limit=1`);
                    if (response.ok) {
                        const apiData = await response.json();
                        if (apiData.data && apiData.data.length > 0) {
                            const flight = apiData.data[0];
                            return {
                                jsonBody: {
                                    flightNumber: flight.flight?.iata || flightNumber,
                                    airline: flight.airline?.name || null,
                                    origin: flight.departure?.airport || flight.departure?.iata || null,
                                    destination: flight.arrival?.airport || flight.arrival?.iata || null,
                                    departureTime: flight.departure?.scheduled || null,
                                    arrivalTime: flight.arrival?.scheduled || null,
                                    status: flight.flight_status || 'scheduled',
                                    delay: flight.departure?.delay ? `${flight.departure.delay} minutes` : null,
                                    gate: flight.departure?.gate || null,
                                    terminal: flight.departure?.terminal || null
                                },
                                headers: { 'Content-Type': 'application/json' }
                            };
                        }
                    }
                } catch (error) {
                    context.log.warn('AviationStack API failed:', error.message);
                }
            }
            
            // If no API key configured, return basic info
            return {
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
                    message: 'Flight API key not configured. Please configure FLIGHT_API_KEY or AVIATIONSTACK_API_KEY in Azure environment variables for full flight information.'
                },
                headers: { 'Content-Type': 'application/json' }
            };
            
        } catch (error) {
            return handleError(context, error, 'Flight lookup failed');
        }
    },
});
