const { app, HttpRequest, InvocationContext } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

// --- DATABASE CLIENT INITIALIZATION (Secures) ---
let cosmosClient = null;
const getCosmosClient = () => {
    if (!cosmosClient) {
        // Reads secrets from Azure Application Settings (Environment Variables)
        const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
        const COSMOS_KEY = process.env.COSMOS_KEY;
        const DATABASE_ID = process.env.DATABASE_ID;

        if (!COSMOS_ENDPOINT || !COSMOS_KEY || !DATABASE_ID) {
            // CRITICAL: This throws an error that gives a 500 status instead of a silent crash.
            throw new Error("COSMOS_DB_CONFIG_MISSING: Missing required environment variables (ENDPOINT, KEY, or DB_ID). Please configure settings in Azure Portal.");
        }

        cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    }
    return { client: cosmosClient, database: cosmosClient.database(process.env.DATABASE_ID) };
};

// Simplified CRUD Helper (Handles GET, POST, PUT, DELETE for all containers)
async function handleCrud(req, context, container, id, containerName) {
    // Attempt to parse body (handles JSON automatically for POST/PUT)
    let body = req.body;
    if (req.method === 'POST' || req.method === 'PUT') {
        try {
            body = req.body || JSON.parse(req.rawBody || '{}');
        } catch (e) {
            body = {};
        }
    }
    
    // Helper to generate a basic ID
    const generateId = () => (Math.random() + 1).toString(36).substring(7) + Date.now().toString(36);

    switch (req.method) {
        case 'GET':
            if (id) {
                // Read by ID (assuming /id partition key)
                const { resource } = await container.item(id, id).read(); 
                context.res.body = resource;
            } else {
                // Read all items
                const { resources } = await container.items.readAll().fetchAll();
                context.res.body = resources;
            }
            break;
        case 'POST':
            const newItem = { ...body, id: body.id || generateId() };
            const { resource: postResource } = await container.items.create(newItem);
            context.res.status = 201;
            context.res.body = postResource;
            break;
        case 'PUT':
            const updateId = id || body.id;
            if (!updateId) {
                context.res.status = 400;
                context.res.body = { error: 'ID required for PUT operation' };
                return;
            }
            // Replace item (assuming /id partition key)
            const { resource: putResource } = await container.item(updateId, updateId).replace(body);
            context.res.body = putResource;
            break;
        case 'DELETE':
            if (!id) {
                context.res.status = 400;
                context.res.body = { error: 'ID required for DELETE operation' };
                return;
            }
            // Delete item (assuming /id partition key)
            await container.item(id, id).delete();
            context.res.status = 204;
            break;
        case 'OPTIONS':
            context.res.status = 200; // Explicitly handle CORS preflight
            break;
        default:
            context.res.status = 405; // Method Not Allowed
            context.res.body = { error: 'Method Not Allowed' };
            break;
    }
}


// --- CORE HANDLER LOGIC (V4 Router) ---
const mainHandler = async (context, req) => {
    // Set default response headers and status
    context.res = {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        },
        body: {}
    };

    if (req.method === 'OPTIONS') {
        return;
    }

    try {
        const { database } = getCosmosClient();

        // 1. Determine resource and optional ID from the URL path
        const urlParts = (req.url || '').split('/').filter(part => part);
        const apiIndex = urlParts.indexOf('api');
        
        if (apiIndex === -1 || apiIndex === urlParts.length - 1) {
            context.res.status = 404;
            context.res.body = { error: 'API resource not specified' };
            return;
        }

        const resource = urlParts[apiIndex + 1];
        const id = urlParts[apiIndex + 2];
        const containerName = (resource === 'events' || resource === 'crc_events') ? 'events' : resource;

        // Route handling 
        switch (containerName) {
            case 'studies':
            case 'sites':
            case 'patients':
            case 'crcs':
            case 'roles':
            // Add any other top-level containers here (e.g., 'training-types')
            case 'training-types': 
                await handleCrud(req, context, database.container(containerName), id, containerName);
                break;
            case 'events':
                // Handles /api/events and /api/crc_events
                await handleCrud(req, context, database.container('events'), id, 'events');
                break;
            default:
                context.res.status = 404;
                context.res.body = { error: `Resource not found: /api/${resource}` };
                break;
        }

    } catch (error) {
        context.res.status = 500;
        context.res.body = { error: error.message || 'Internal Server Error (Check Azure Logs)' };
        context.log.error('FATAL API CRASH:', error.message);
    }
    
    // Final serialization check
    if (typeof context.res.body === 'object' && context.res.status !== 204) {
        context.res.body = JSON.stringify(context.res.body);
    }
};

// --- V4 FUNCTION REGISTRATION ---
// Register ONE generic function that catches all /api calls.
app.http('router', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: '{*path}', 
    handler: mainHandler
});
