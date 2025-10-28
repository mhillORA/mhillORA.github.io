const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

// --- START DEBUG LOGGING ---
console.log('[API START] Loading index.js...');
// --- END DEBUG LOGGING ---

try { // --- ADDED TOP-LEVEL TRY ---

    // Helper function to generate unique IDs
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    // Helper function to get Cosmos DB client (lazy initialization)
    let cosmosClient = null;
    let database = null;

    const getCosmosClient = () => {
        // --- START DEBUG LOGGING ---
        console.log('[getCosmosClient] Attempting to get client...');
        // --- END DEBUG LOGGING ---
        if (cosmosClient) {
            console.log('[getCosmosClient] Returning existing client.');
            return { client: cosmosClient, database };
        }

        // Safely read environment variables
        const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
        const COSMOS_KEY = process.env.COSMOS_KEY;
        const DATABASE_ID = process.env.DATABASE_ID;

        // --- START DEBUG LOGGING ---
        console.log(`[getCosmosClient] COSMOS_ENDPOINT value: ${COSMOS_ENDPOINT ? 'Present' : 'MISSING!'}`); // Hide value
        console.log(`[getCosmosClient] COSMOS_KEY value: ${COSMOS_KEY ? 'Present' : 'MISSING!'}`); // Hide value
        console.log(`[getCosmosClient] DATABASE_ID value: ${DATABASE_ID ? DATABASE_ID : 'MISSING!'}`);
        // --- END DEBUG LOGGING ---

        // CRASH FIX: Check for required secrets *before* instantiation
        if (!COSMOS_ENDPOINT || !COSMOS_KEY || !DATABASE_ID) {
            const missing = ['COSMOS_ENDPOINT', 'COSMOS_KEY', 'DATABASE_ID'].filter(key => !process.env[key]);
            console.error(`[getCosmosClient] ERROR: Missing environment variables: ${missing.join(', ')}`);
            throw new Error(`Missing required Cosmos DB environment variables: ${missing.join(', ')}. Please configure them in Azure Static Web App configuration.`);
        }

        try {
            console.log('[getCosmosClient] Initializing CosmosClient...');
            cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
            database = cosmosClient.database(DATABASE_ID);
            console.log('[getCosmosClient] CosmosClient initialized successfully.');
        } catch (initError) {
            console.error('[getCosmosClient] CRITICAL ERROR during CosmosClient initialization:', initError);
            throw new Error(`Failed to initialize Cosmos DB client: ${initError.message}`);
        }

        return { client: cosmosClient, database };
    };

    // Helper function to get container
    const getContainer = (containerName) => {
        try {
            console.log(`[getContainer] Getting container: ${containerName}`);
            const { database } = getCosmosClient(); // Ensure client is initialized
            if (!database) {
                 console.error('[getContainer] ERROR: Database object is null or undefined after getCosmosClient.');
                 throw new Error('Database object not initialized.');
            }
            const container = database.container(containerName);
            console.log(`[getContainer] Successfully got container object: ${containerName}`);
            // --- ADDED PARTITION KEY CHECK ---
            // Note: This check runs only once per container type during runtime.
            // It might fail if the container doesn't exist yet or permissions are wrong.
            container.read()
                .then(response => {
                    const partitionKeyPath = response.resource.partitionKey?.paths?.[0];
                    console.log(`[getContainer] Container '${containerName}' actual partition key path: ${partitionKeyPath}`);
                    if (partitionKeyPath !== '/id') {
                         console.warn(`[getContainer] WARNING: Container '${containerName}' partition key is '${partitionKeyPath}', but code assumes '/id'. This might cause query issues.`);
                    }
                })
                .catch(readError => {
                    // Log error reading container definition but don't crash here,
                    // let the actual operation fail later if needed.
                    console.error(`[getContainer] Could not read definition for container '${containerName}'. Check existence/permissions. Error:`, readError.message);
                 });
            // --- END PARTITION KEY CHECK ---
            return container;
        } catch (containerError) {
            console.error(`[getContainer] ERROR getting container '${containerName}':`, containerError);
            throw containerError; // Rethrow to be caught by main handler
        }
    };

    // Generic CRUD handler
    async function handleCrud(request, context, containerName) {
        const { method } = request;
        const id = request.params.id;
        // --- Assume partition key is always the ID for simplicity now ---
        const partitionKey = id;
        // --- Log this assumption ---
        context.log(`[handleCrud ${containerName}] Using Partition Key: ${partitionKey || 'N/A for readAll'}`);

        context.log(`[handleCrud ${containerName}] Request received: ${method} ${id ? `(ID: ${id})` : '(All)'}`);

        try {
            const container = getContainer(containerName); // Get container instance

            // Handle CORS preflight explicitly for each function registration
            if (method === 'OPTIONS') {
                context.log(`[handleCrud ${containerName}] Responding to OPTIONS request.`);
                return {
                    status: 200,
                    headers: {
                        'Access-Control-Allow-Origin': '*', // Be more specific in production
                        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
                    }
                };
            }

            switch (method) {
                case 'GET':
                    if (id) {
                        context.log(`[handleCrud ${containerName}] Reading item with ID: ${id}, PK: ${partitionKey}`);
                        // --- SPECIFY PARTITION KEY ---
                        const { resource: item } = await container.item(id, partitionKey).read();
                        context.log(`[handleCrud ${containerName}] Item read successfully.`);
                        return { status: 200, jsonBody: item };
                    } else {
                        context.log(`[handleCrud ${containerName}] Reading all items...`);
                        const { resources } = await container.items.readAll().fetchAll();
                        context.log(`[handleCrud ${containerName}] Read ${resources.length} items successfully.`);
                        return { status: 200, jsonBody: resources };
                    }
                case 'POST':
                    context.log(`[handleCrud ${containerName}] Creating new item...`);
                    const newItemData = await request.json(); // Use await request.json() for V4
                    const newItem = { ...newItemData, id: generateId() };
                    // --- ENSURE PARTITION KEY IS SET IF NEEDED ---
                    // If your partition key is '/id', this is fine.
                    // If it's something else (e.g., '/type'), you need: newItem.type = 'someValue';
                    context.log(`[handleCrud ${containerName}] Item data to create:`, JSON.stringify(newItem));
                    const { resource: createdItem } = await container.items.create(newItem);
                    context.log(`[handleCrud ${containerName}] Item created successfully with ID: ${createdItem.id}`);
                    return { status: 201, jsonBody: createdItem };
                case 'PUT':
                    if (!id) throw new Error('PUT requires an ID.');
                    context.log(`[handleCrud ${containerName}] Replacing item with ID: ${id}, PK: ${partitionKey}`);
                    const updatedItemData = await request.json(); // Use await request.json() for V4
                    const updatedItem = { ...updatedItemData, id }; // Ensure ID is part of the replacement
                    // --- SPECIFY PARTITION KEY ---
                    const { resource: replacedItem } = await container.item(id, partitionKey).replace(updatedItem);
                    context.log(`[handleCrud ${containerName}] Item replaced successfully.`);
                    return { status: 200, jsonBody: replacedItem };
                case 'DELETE':
                    if (!id) throw new Error('DELETE requires an ID.');
                    context.log(`[handleCrud ${containerName}] Deleting item with ID: ${id}, PK: ${partitionKey}`);
                    // --- SPECIFY PARTITION KEY ---
                    await container.item(id, partitionKey).delete();
                    context.log(`[handleCrud ${containerName}] Item deleted successfully.`);
                    return { status: 204 }; // No body for 204
                default:
                     context.log(`[handleCrud ${containerName}] ERROR: Method not allowed: ${method}`);
                    return { status: 405, body: 'Method Not Allowed' };
            }
        } catch (error) {
            context.error(`[handleCrud ${containerName}] CRASH during operation ${method}:`, error);
            if (error.code) context.error(`   Cosmos DB Error Code: ${error.code}`);
            if (error.statusCode) context.error(`   Cosmos DB Status Code: ${error.statusCode}`);
            // Add partition key info to error if available
            if (error.message && error.message.includes('PartitionKey')) {
                 context.error(`   Potential Partition Key mismatch detected.`);
            }

            // Return a structured JSON error even on crash
            return {
                status: error.statusCode || 500,
                headers: { 'Content-Type': 'application/json' },
                jsonBody: { error: `API Error in ${containerName}: ${error.message || 'An internal server error occurred.'}` }
            };
        }
    }

    // Register functions using the V4 model
    const registerFunction = (name, route) => {
        try { // --- ADDED TRY AROUND REGISTRATION ---
            console.log(`[API REGISTER] Registering function: ${name} at route: ${route}/{id?}`);
            app.http(name, {
                methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
                authLevel: 'anonymous',
                route: `${route}/{id?}`,
                handler: (request, context) => handleCrud(request, context, name)
            });
            console.log(`[API REGISTER] Successfully registered function: ${name}`);
        } catch (registerError) {
             console.error(`[API REGISTER] FAILED to register function ${name}:`, registerError);
             // Optionally rethrow if you want registration failure to halt everything
             // throw registerError;
        }
    };

    registerFunction('studies', 'studies');
    registerFunction('sites', 'sites');
    registerFunction('patients', 'patients');
    registerFunction('crcs', 'crcs');
    registerFunction('events', 'events');
    registerFunction('roles', 'roles');
    registerFunction('training-types', 'training_types');

    console.log('[API READY] All functions registered.');

} catch (topLevelError) { // --- CATCH TOP-LEVEL ERRORS ---
    console.error('[API FATAL] Uncaught error during API initialization:', topLevelError);
    // If the app object exists, try registering a fallback error handler
    // This is a last resort and might not work if the crash is too early
    try {
        if (app && app.http) {
             console.log('[API FATAL] Attempting to register fallback error handler...');
             app.http('fallbackError', {
                 methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
                 authLevel: 'anonymous',
                 route: '{*route}', // Catch-all route
                 handler: async (request, context) => {
                      context.error('[API FATAL] Fallback handler caught request due to initialization error:', topLevelError);
                      return {
                          status: 500,
                          headers: { 'Content-Type': 'application/json' },
                          jsonBody: {
                              error: 'API failed to initialize. Check deployment logs.',
                              detail: topLevelError.message || 'Unknown initialization error'
                           }
                      };
                 }
             });
             console.log('[API FATAL] Fallback error handler registered.');
        } else {
             console.error('[API FATAL] Cannot register fallback handler, app object not available.');
        }
    } catch (fallbackRegisterError) {
         console.error('[API FATAL] Error registering fallback handler:', fallbackRegisterError);
    }
}
// --- END TOP-LEVEL TRY/CATCH ---

