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

// --- Core CRUD Handlers (Template) ---
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
                    return { jsonBody: resource };
                } else {
                    const { resources } = await container.items.readAll().fetchAll();
                    return { jsonBody: resources };
                }
            
            case 'POST':
                const body = await request.json();
                const newItem = { ...body, id: generateId() };
                const { resource: createdItem } = await container.items.create(newItem);
                return { status: 201, jsonBody: createdItem };
            
            case 'PUT':
                const updateId = id || (await request.json()).id;
                const updatedItem = { ...(await request.json()), id: updateId };
                const { resource: result } = await container.item(updateId).replace(updatedItem);
                return { jsonBody: result };

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
