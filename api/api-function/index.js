const { CosmosClient } = require('@azure/cosmos');

// Cosmos DB configuration
const COSMOS_ENDPOINT = 'https://ora-clinical-recruiting.documents.azure.com:443/';
const COSMOS_KEY = 'rl7a83apOq35OqfKpNt7hTRyeeQVftD8SHitw2QW0w7Kd1S39YJfeZEm29fGQapYumgh0Bm6NEbjACDbH1iO9g==';
const DATABASE_ID = 'crcscheduling';

const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
const database = client.database(DATABASE_ID);

module.exports = async function (context, req) {
    context.log('Processing request:', req.method, req.url);

    try {
        // Handle CORS
        context.res.headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        };

        if (req.method === 'OPTIONS') {
            context.res.status = 200;
            return;
        }

        const path = req.url.replace('/api/', '');
        const pathParts = path.split('/');
        const resource = pathParts[0];
        const id = pathParts[1];

        // Route handling
        switch (resource) {
            case 'studies':
                if (req.method === 'GET') {
                    const { resources } = await database.container('studies').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('studies').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('studies').item(id, id).replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('studies').item(id, id).delete();
                    context.res.status = 204;
                }
                break;

            case 'sites':
                if (req.method === 'GET') {
                    const { resources } = await database.container('sites').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('sites').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('sites').item(id, id).replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('sites').item(id, id).delete();
                    context.res.status = 204;
                }
                break;

            case 'patients':
                if (req.method === 'GET') {
                    const { resources } = await database.container('patients').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('patients').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('patients').item(id, id).replace(req.body);
                    context.res.body = resource;
                }
                break;

            case 'crcs':
                if (req.method === 'GET') {
                    const { resources } = await database.container('crcs').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('crcs').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('crcs').item(id, id).replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('crcs').item(id, id).delete();
                    context.res.status = 204;
                }
                break;

            case 'events':
            case 'crc_events':
                if (req.method === 'GET') {
                    const { resources } = await database.container('events').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('events').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('events').item(id, id).replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('events').item(id, id).delete();
                    context.res.status = 204;
                }
                break;

            case 'schedules':
                if (req.method === 'GET') {
                    const { resources } = await database.container('schedules').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('schedules').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('schedules').item(id, id).replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('schedules').item(id, id).delete();
                    context.res.status = 204;
                }
                break;

            case 'surveys':
                if (req.method === 'GET') {
                    const { resources } = await database.container('surveys').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('surveys').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('surveys').item(id, id).replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('surveys').item(id, id).delete();
                    context.res.status = 204;
                }
                break;

            case 'roles':
                if (req.method === 'GET') {
                    const { resources } = await database.container('roles').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('roles').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                } else if (req.method === 'PUT' && id) {
                    const { resource } = await database.container('roles').item(id, id).replace(req.body);
                    context.res.body = resource;
                } else if (req.method === 'DELETE' && id) {
                    await database.container('roles').item(id, id).delete();
                    context.res.status = 204;
                }
                break;

            case 'training-types':
                if (req.method === 'GET') {
                    const { resources } = await database.container('training_types').items.readAll().fetchAll();
                    context.res.body = resources;
                } else if (req.method === 'POST') {
                    const { resource } = await database.container('training_types').items.create(req.body);
                    context.res.status = 201;
                    context.res.body = resource;
                }
                break;

            default:
                context.res.status = 404;
                context.res.body = { error: 'Resource not found' };
        }

    } catch (error) {
        context.log.error('Error:', error);
        context.res = {
            status: 500,
            body: { error: error.message }
        };
    }
};
