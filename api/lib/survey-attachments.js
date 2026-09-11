/**
 * Survey invite attachments (ops → site).
 * Stored in Cosmos `survey-attachments` as base64 (small PDFs / docs).
 * Soft limits keep documents under Cosmos item size.
 */

const ATTACHMENTS = 'survey-attachments';
const MAX_FILES = 5;
const MAX_BYTES = 1_200_000; // ~1.2 MB decoded
const ALLOWED_EXT = new Set([
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'csv',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'txt',
]);

function sanitizeFileName(name) {
    const base = String(name || 'attachment')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return base || 'attachment';
}

function extOf(name) {
    const m = String(name || '')
        .toLowerCase()
        .match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

function stripDataUrl(b64) {
    const s = String(b64 || '');
    const i = s.indexOf('base64,');
    return i >= 0 ? s.slice(i + 7) : s.replace(/\s+/g, '');
}

function approxBytesFromBase64(b64) {
    const s = stripDataUrl(b64);
    return Math.floor((s.length * 3) / 4);
}

function guessContentType(ext) {
    const map = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        csv: 'text/csv',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        txt: 'text/plain',
    };
    return map[ext] || 'application/octet-stream';
}

function normalizeIncomingAttachments(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    if (list.length > MAX_FILES) {
        throw new Error(`At most ${MAX_FILES} attachments allowed per send.`);
    }
    return list.map((item, idx) => {
        const fileName = sanitizeFileName(item?.fileName || item?.name || `file-${idx + 1}`);
        const ext = extOf(fileName);
        if (!ALLOWED_EXT.has(ext)) {
            throw new Error(
                `Unsupported file type for ${fileName}. Allowed: ${[...ALLOWED_EXT].join(', ')}`
            );
        }
        const contentBase64 = stripDataUrl(item?.contentBase64 || item?.content || '');
        if (!contentBase64 || contentBase64.length < 8) {
            throw new Error(`Missing file content for ${fileName}`);
        }
        const size = Number(item?.size) || approxBytesFromBase64(contentBase64);
        if (size > MAX_BYTES) {
            throw new Error(
                `${fileName} is too large (${Math.round(size / 1024)} KB). Max ${Math.round(MAX_BYTES / 1024)} KB per file.`
            );
        }
        const contentType =
            String(item?.contentType || item?.type || '').trim() || guessContentType(ext);
        return { fileName, contentType, contentBase64, size };
    });
}

function parseCcList(raw) {
    const text = Array.isArray(raw) ? raw.join(',') : String(raw || '');
    const emails = text
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    return [...new Set(emails)].slice(0, 20);
}

async function ensureAttachmentsContainer(getCosmosClient) {
    if (!getCosmosClient) return;
    try {
        const { database } = getCosmosClient();
        await database.containers.createIfNotExists({
            id: ATTACHMENTS,
            partitionKey: { paths: ['/id'] },
        });
    } catch (_) {}
}

async function persistAttachments(getContainer, getCosmosClient, generateId, files, meta = {}) {
    await ensureAttachmentsContainer(getCosmosClient);
    const c = getContainer(ATTACHMENTS);
    const now = new Date().toISOString();
    const saved = [];
    for (const f of files) {
        const id = generateId();
        const doc = {
            id,
            fileName: f.fileName,
            contentType: f.contentType,
            size: f.size,
            contentBase64: f.contentBase64,
            surveyId: meta.surveyId || null,
            batchId: meta.batchId || null,
            createdAt: now,
            createdBy: meta.operator || null,
        };
        await c.items.create(doc);
        saved.push({
            id,
            fileName: f.fileName,
            contentType: f.contentType,
            size: f.size,
        });
    }
    return saved;
}

async function loadAttachmentDocs(getContainer, ids) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return [];
    const c = getContainer(ATTACHMENTS);
    const out = [];
    for (const id of list) {
        try {
            const { resource } = await c.item(id, id).read();
            if (resource) out.push(resource);
        } catch (_) {}
    }
    return out;
}

function publicAttachmentMeta(docs) {
    return (docs || []).map((d) => ({
        id: d.id,
        fileName: d.fileName,
        contentType: d.contentType,
        size: d.size,
    }));
}

function emailAttachmentPayload(docs) {
    return (docs || []).map((d) => ({
        fileName: d.fileName,
        contentType: d.contentType || 'application/octet-stream',
        contentBase64: stripDataUrl(d.contentBase64),
    }));
}

module.exports = {
    ATTACHMENTS,
    MAX_FILES,
    MAX_BYTES,
    normalizeIncomingAttachments,
    parseCcList,
    persistAttachments,
    loadAttachmentDocs,
    publicAttachmentMeta,
    emailAttachmentPayload,
};
