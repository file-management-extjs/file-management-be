const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const https = require('https');
const mime = require('mime');

const File = require('../models/fileModel');
const Workspace = require('../models/workspaceModel');
const Organization = require('../models/organizationModel');
const WorkspaceService = require('./workspaceService');
const OrganizationPolicyService = require('./organizationPolicyService');
const StorageService = require('./storage/storageService');
const { fileEvents, EVENT_TYPES } = require('./eventService');
const config = require('../config');

const SUPPORTED_PROVIDER_TYPES = ['local', 'openai', 'anthropic', 'huggingface', 'generic'];
const DEFAULT_SETTINGS = {
    enabled: false,
    autoProcessUploads: false,
    provider: {
        type: 'local',
        model: '',
        endpoint: '',
        apiKey: ''
    },
    ocr: {
        enabled: true,
        provider: 'local',
        model: '',
        endpoint: '',
        apiKey: '',
        language: 'eng',
        dpi: 220
    },
    features: {
        classification: true,
        tagging: true,
        summarization: true,
        imageRecognition: true
    },
    limits: {
        maxTextChars: 40000,
        maxFileSizeMb: 100,
        maxPages: 12
    }
};

const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.html', '.htm', '.log', '.yaml', '.yml']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz']);

function safeId(value) {
    return value && value.toString ? value.toString() : String(value || '');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function toBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function toInteger(value, fallback, min, max) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.max(min, Math.min(max, parsed));
}

function toStringValue(value, fallback = '') {
    if (value === null || value === undefined) {
        return fallback;
    }

    return String(value).trim();
}

function pickEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function isMaskedSecret(value) {
    return /^\*{4,}$/.test(String(value || '').trim());
}

function mergeSecret(nextValue, existingValue) {
    const value = toStringValue(nextValue);
    if (!value || isMaskedSecret(value)) {
        return existingValue || '';
    }

    return value;
}

function extensionOf(file) {
    return path.extname(file && (file.name || file.path) || '').toLowerCase();
}

function normalizeWhitespace(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function truncate(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) {
        return text;
    }

    return text.slice(0, maxLength);
}

function uniqueStrings(values, max = 20) {
    const seen = new Set();
    const result = [];

    (values || []).forEach(value => {
        const normalized = toStringValue(value).replace(/\s+/g, ' ');
        if (!normalized) {
            return;
        }

        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        result.push(normalized.slice(0, 80));
    });

    return result.slice(0, max);
}

function postRequest(urlString, { headers = {}, body = null, timeoutMs = 90000, binary = false } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const client = url.protocol === 'https:' ? https : http;
        const payload = Buffer.isBuffer(body)
            ? body
            : (body === null || body === undefined ? null : Buffer.from(String(body)));

        const request = client.request({
            method: 'POST',
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            headers: {
                ...(payload ? { 'Content-Length': payload.length } : {}),
                ...headers
            },
            timeout: timeoutMs
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    const error = new Error(`Provider request failed with HTTP ${response.statusCode}: ${responseBody.slice(0, 300)}`);
                    error.statusCode = response.statusCode;
                    reject(error);
                    return;
                }

                if (binary) {
                    resolve(Buffer.concat(chunks));
                    return;
                }

                resolve(responseBody);
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error('Provider request timed out.'));
        });
        request.on('error', reject);

        if (payload) {
            request.write(payload);
        }

        request.end();
    });
}

class ContentIntelligenceService {
    static initialized = false;

    static getDefaultSettings() {
        return clone(DEFAULT_SETTINGS);
    }

    static normalizeSettings(input = {}, existingSettings = {}) {
        const raw = isPlainObject(input) ? input : {};
        const existing = this.mergeSettings(existingSettings || {});
        const providerRaw = isPlainObject(raw.provider) ? raw.provider : {};
        const ocrRaw = isPlainObject(raw.ocr) ? raw.ocr : {};
        const featuresRaw = isPlainObject(raw.features) ? raw.features : {};
        const limitsRaw = isPlainObject(raw.limits) ? raw.limits : {};
        const providerType = pickEnum(providerRaw.type || raw.providerType, SUPPORTED_PROVIDER_TYPES, existing.provider.type);

        return {
            enabled: toBoolean(raw.enabled, existing.enabled),
            autoProcessUploads: toBoolean(raw.autoProcessUploads, existing.autoProcessUploads),
            provider: {
                type: providerType,
                model: toStringValue(providerRaw.model, existing.provider.model),
                endpoint: toStringValue(providerRaw.endpoint, existing.provider.endpoint),
                apiKey: mergeSecret(providerRaw.apiKey, existing.provider.apiKey)
            },
            ocr: {
                enabled: toBoolean(ocrRaw.enabled, existing.ocr.enabled),
                provider: pickEnum(ocrRaw.provider, SUPPORTED_PROVIDER_TYPES, existing.ocr.provider),
                model: toStringValue(ocrRaw.model, existing.ocr.model),
                endpoint: toStringValue(ocrRaw.endpoint, existing.ocr.endpoint),
                apiKey: mergeSecret(ocrRaw.apiKey, existing.ocr.apiKey),
                language: toStringValue(ocrRaw.language, existing.ocr.language || 'eng') || 'eng',
                dpi: toInteger(ocrRaw.dpi, existing.ocr.dpi, 120, 400)
            },
            features: {
                classification: toBoolean(featuresRaw.classification, existing.features.classification),
                tagging: toBoolean(featuresRaw.tagging, existing.features.tagging),
                summarization: toBoolean(featuresRaw.summarization, existing.features.summarization),
                imageRecognition: toBoolean(featuresRaw.imageRecognition, existing.features.imageRecognition)
            },
            limits: {
                maxTextChars: toInteger(limitsRaw.maxTextChars, existing.limits.maxTextChars, 1000, 200000),
                maxFileSizeMb: toInteger(limitsRaw.maxFileSizeMb, existing.limits.maxFileSizeMb, 1, 1000),
                maxPages: toInteger(limitsRaw.maxPages, existing.limits.maxPages, 1, 100)
            }
        };
    }

    static mergeSettings(settings = {}) {
        return this.normalizeSettingsInternal(settings, clone(DEFAULT_SETTINGS));
    }

    static normalizeSettingsInternal(input = {}, defaults = clone(DEFAULT_SETTINGS)) {
        const raw = isPlainObject(input) ? input : {};
        const providerRaw = isPlainObject(raw.provider) ? raw.provider : {};
        const ocrRaw = isPlainObject(raw.ocr) ? raw.ocr : {};
        const featuresRaw = isPlainObject(raw.features) ? raw.features : {};
        const limitsRaw = isPlainObject(raw.limits) ? raw.limits : {};

        return {
            enabled: toBoolean(raw.enabled, defaults.enabled),
            autoProcessUploads: toBoolean(raw.autoProcessUploads, defaults.autoProcessUploads),
            provider: {
                type: pickEnum(providerRaw.type || raw.providerType, SUPPORTED_PROVIDER_TYPES, defaults.provider.type),
                model: toStringValue(providerRaw.model, defaults.provider.model),
                endpoint: toStringValue(providerRaw.endpoint, defaults.provider.endpoint),
                apiKey: toStringValue(providerRaw.apiKey, defaults.provider.apiKey)
            },
            ocr: {
                enabled: toBoolean(ocrRaw.enabled, defaults.ocr.enabled),
                provider: pickEnum(ocrRaw.provider, SUPPORTED_PROVIDER_TYPES, defaults.ocr.provider),
                model: toStringValue(ocrRaw.model, defaults.ocr.model),
                endpoint: toStringValue(ocrRaw.endpoint, defaults.ocr.endpoint),
                apiKey: toStringValue(ocrRaw.apiKey, defaults.ocr.apiKey),
                language: toStringValue(ocrRaw.language, defaults.ocr.language || 'eng') || 'eng',
                dpi: toInteger(ocrRaw.dpi, defaults.ocr.dpi, 120, 400)
            },
            features: {
                classification: toBoolean(featuresRaw.classification, defaults.features.classification),
                tagging: toBoolean(featuresRaw.tagging, defaults.features.tagging),
                summarization: toBoolean(featuresRaw.summarization, defaults.features.summarization),
                imageRecognition: toBoolean(featuresRaw.imageRecognition, defaults.features.imageRecognition)
            },
            limits: {
                maxTextChars: toInteger(limitsRaw.maxTextChars, defaults.limits.maxTextChars, 1000, 200000),
                maxFileSizeMb: toInteger(limitsRaw.maxFileSizeMb, defaults.limits.maxFileSizeMb, 1, 1000),
                maxPages: toInteger(limitsRaw.maxPages, defaults.limits.maxPages, 1, 100)
            }
        };
    }

    static redactSettings(settings = {}) {
        const redacted = this.mergeSettings(settings);
        if (redacted.provider.apiKey) {
            redacted.provider.apiKey = '********';
        }
        if (redacted.ocr.apiKey) {
            redacted.ocr.apiKey = '********';
        }

        return redacted;
    }

    static async getWorkspaceSettings(userId, workspaceId = null) {
        const context = await WorkspaceService.assertWorkspaceAccess(userId, workspaceId || null);
        const workspace = context.workspace;
        let ownerOnly = false;
        let canManage = workspace.type === 'personal';
        let settingsSource = workspace.settings || {};
        let organization = null;

        if (workspace.type === 'organization') {
            organization = await Organization.findById(workspace.organizationId).lean();
            settingsSource = organization && organization.settings ? organization.settings : {};
            ownerOnly = true;
            canManage = this.isOrganizationOwner(userId, organization, context.membership);
        }

        return {
            workspace: WorkspaceService.serialize(workspace),
            scope: workspace.type,
            ownerOnly,
            canManage,
            settings: this.redactSettings(settingsSource.contentIntelligence || {})
        };
    }

    static isOrganizationOwner(userId, organization, membership) {
        const normalizedUserId = userId.toString();
        return !!(
            organization &&
            (organization.ownerUserId === normalizedUserId ||
                (membership && Array.isArray(membership.roles) && membership.roles.includes('owner')))
        );
    }

    static async saveWorkspaceSettings(userId, workspaceId, payload = {}) {
        const context = await WorkspaceService.assertWorkspaceAccess(userId, workspaceId || null);
        const workspace = context.workspace;
        const incoming = isPlainObject(payload.settings) ? payload.settings : payload;

        if (workspace.type === 'personal') {
            if (workspace.ownerUserId !== userId.toString()) {
                throw OrganizationPolicyService.createError('Workspace owner permissions are required.', 403, 'WORKSPACE_OWNER_REQUIRED');
            }

            const existingSettings = workspace.settings || {};
            const contentIntelligence = this.normalizeSettings(incoming, existingSettings.contentIntelligence || {});
            const nextSettings = {
                ...existingSettings,
                contentIntelligence
            };

            const updated = await Workspace.findByIdAndUpdate(
                workspace._id,
                { $set: { settings: nextSettings } },
                { new: true }
            ).lean();

            return {
                workspace: WorkspaceService.serialize(updated),
                scope: 'personal',
                ownerOnly: false,
                canManage: true,
                settings: this.redactSettings(contentIntelligence)
            };
        }

        const organization = await Organization.findById(workspace.organizationId).lean();
        if (!this.isOrganizationOwner(userId, organization, context.membership)) {
            throw OrganizationPolicyService.createError('Organization owner permissions are required.', 403, 'ORG_OWNER_REQUIRED');
        }

        const existingSettings = organization.settings || {};
        const contentIntelligence = this.normalizeSettings(incoming, existingSettings.contentIntelligence || {});
        const nextSettings = {
            ...existingSettings,
            contentIntelligence
        };
        await Organization.findByIdAndUpdate(
            organization._id,
            { $set: { settings: nextSettings } },
            { new: true }
        ).lean();

        return {
            workspace: WorkspaceService.serialize(workspace),
            scope: 'organization',
            ownerOnly: true,
            canManage: true,
            settings: this.redactSettings(contentIntelligence)
        };
    }

    static async getSettingsForWorkspace(workspaceId) {
        const workspace = await Workspace.findById(workspaceId).lean();
        if (!workspace) {
            return this.mergeSettings();
        }

        if (workspace.type === 'organization') {
            const organization = await Organization.findById(workspace.organizationId).lean();
            return this.mergeSettings((organization && organization.settings && organization.settings.contentIntelligence) || {});
        }

        return this.mergeSettings((workspace.settings && workspace.settings.contentIntelligence) || {});
    }

    static getFileCapability(file, settings = this.mergeSettings()) {
        if (!file || file.deleted) {
            return {
                supported: false,
                category: 'unknown',
                reason: 'File is not available.'
            };
        }

        const mimetype = String(file.mimetype || mime.getType(file.name || file.path) || '').toLowerCase();
        const ext = extensionOf(file);
        const sizeMb = (Number(file.size) || 0) / (1024 * 1024);

        if (sizeMb > settings.limits.maxFileSizeMb) {
            return {
                supported: false,
                category: 'oversized',
                reason: `File is larger than the ${settings.limits.maxFileSizeMb} MB content intelligence limit.`
            };
        }

        if (mimetype.indexOf('video/') === 0 || mimetype.indexOf('audio/') === 0) {
            return {
                supported: false,
                category: 'media',
                reason: 'Audio and video files are not content-extractable by this worker.'
            };
        }

        if (ARCHIVE_EXTENSIONS.has(ext) || /zip|rar|7z|tar|gzip|compressed/.test(mimetype)) {
            return {
                supported: false,
                category: 'archive',
                reason: 'Archive files are excluded from content extraction.'
            };
        }

        if (mimetype === 'application/pdf' || ext === '.pdf') {
            return { supported: true, category: 'pdf', extraction: 'pdf' };
        }

        if (mimetype.indexOf('image/') === 0 || IMAGE_EXTENSIONS.has(ext)) {
            return settings.ocr.enabled || settings.features.imageRecognition
                ? { supported: true, category: 'image', extraction: 'ocr' }
                : { supported: false, category: 'image', reason: 'OCR or image recognition must be enabled for images.' };
        }

        if (mimetype.indexOf('text/') === 0 ||
            ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'].includes(mimetype) ||
            TEXT_EXTENSIONS.has(ext)) {
            return { supported: true, category: 'text', extraction: 'text' };
        }

        if (OFFICE_EXTENSIONS.has(ext) ||
            /word|excel|powerpoint|spreadsheet|presentation|opendocument|rtf/.test(mimetype)) {
            return { supported: true, category: 'office', extraction: 'office' };
        }

        return {
            supported: false,
            category: 'unknown',
            reason: 'This file type is not supported for content intelligence.'
        };
    }

    static serializeState(file, overrides = {}) {
        const info = file.contentIntelligence || {};

        return {
            fileId: safeId(file._id),
            fileName: file.name,
            filePath: file.path,
            parentId: file.parent_id || null,
            workspaceId: file.workspaceId || null,
            mimetype: file.mimetype || '',
            size: file.size || 0,
            status: overrides.status || info.status || 'idle',
            stage: overrides.stage || info.stage || null,
            progress: overrides.progress !== undefined ? overrides.progress : (info.progress || 0),
            classification: overrides.classification !== undefined ? overrides.classification : (info.classification || null),
            tags: overrides.tags !== undefined ? overrides.tags : (info.tags || []),
            error: overrides.error !== undefined ? overrides.error : (info.error || null),
            message: overrides.message || null
        };
    }

    static emitUpdate(userIds = [], payload = {}) {
        try {
            const socket = require('../socket');
            const io = socket.getIO();
            [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))]
                .forEach(userId => io.to(userId).emit('contentIntelligenceUpdate', payload));
        } catch (error) {
            console.error('Failed to emit content intelligence update:', error.message);
        }
    }

    static async prepareQueueRequest(userId, fileId, workspaceId = null, options = {}) {
        const context = await WorkspaceService.assertWorkspaceAccess(userId, workspaceId || null);
        const workspaceIdString = context.workspace._id.toString();
        const file = await File.findOne({
            _id: fileId,
            workspaceId: workspaceIdString,
            deleted: false
        });

        if (!file) {
            const error = new Error('File not found or access denied.');
            error.statusCode = 404;
            throw error;
        }

        if (file.isPasswordProtected) {
            const error = new Error('Password-protected files must be unlocked before content extraction.');
            error.statusCode = 403;
            throw error;
        }

        const settings = await this.getSettingsForWorkspace(workspaceIdString);
        const capability = this.getFileCapability(file, settings);
        if (!capability.supported) {
            file.contentIntelligence = {
                ...(file.contentIntelligence || {}),
                status: 'unsupported',
                stage: 'unsupported',
                progress: 0,
                error: capability.reason,
                manuallyTriggered: options.manual === true,
                lastRunAt: new Date()
            };
            await file.save();

            const error = new Error(capability.reason);
            error.statusCode = 400;
            throw error;
        }

        const currentStatus = file.contentIntelligence && file.contentIntelligence.status;
        if (['queued', 'processing'].includes(currentStatus)) {
            return {
                queued: false,
                file,
                progressId: options.progressId || `ci-${file._id}`,
                state: this.serializeState(file, {
                    message: `"${file.name}" is already queued for content intelligence.`
                })
            };
        }

        file.contentIntelligence = {
            ...(file.contentIntelligence || {}),
            status: 'queued',
            stage: 'queued',
            progress: 0,
            error: null,
            manuallyTriggered: options.manual === true,
            lastRunAt: new Date(),
            completedAt: null
        };
        await file.save();

        return {
            queued: true,
            file,
            workspaceId: workspaceIdString,
            progressId: options.progressId || `ci-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            state: this.serializeState(file, {
                status: 'queued',
                stage: 'queued',
                progress: 0,
                message: `"${file.name}" was queued for content intelligence.`
            })
        };
    }

    static async updateFileState(file, patch = {}) {
        file.contentIntelligence = {
            ...(file.contentIntelligence || {}),
            ...patch
        };
        await file.save();
        return file;
    }

    static async runFileIntelligence({ userId, fileId, workspaceId, manual = false }, options = {}) {
        const file = await File.findOne({
            _id: fileId,
            workspaceId,
            deleted: false
        });

        if (!file) {
            throw new Error('File not found.');
        }

        const settings = await this.getSettingsForWorkspace(workspaceId || file.workspaceId);
        const capability = this.getFileCapability(file, settings);
        if (!capability.supported) {
            throw new Error(capability.reason);
        }

        const emitProgress = async (stage, progress, message) => {
            await this.updateFileState(file, {
                status: 'processing',
                stage,
                progress,
                error: null,
                lastRunAt: new Date(),
                manuallyTriggered: manual === true
            });

            if (options.onProgress) {
                options.onProgress({
                    ...this.serializeState(file, { status: 'processing', stage, progress, message }),
                    workspaceId
                });
            }
        };

        await fs.ensureDir(config.contentIntelligence.workRoot);
        const jobDir = path.join(config.contentIntelligence.workRoot, `${file._id}-${Date.now()}`);
        const sourcePath = path.join(jobDir, file.name || `${file._id}`);
        let materializedPath = null;

        try {
            await fs.ensureDir(jobDir);
            await emitProgress('materializing', 8, `Preparing ${file.name}`);
            materializedPath = await StorageService.materializeFile(file, sourcePath);

            await emitProgress('extracting', 24, `Extracting text from ${file.name}`);
            const workerResult = await this.executeWorkerAnalysis(file, materializedPath, capability, settings);
            const extraction = workerResult.extraction || {};
            const analysis = workerResult.analysis || {};
            const searchableText = truncate(
                normalizeWhitespace(extraction.searchableText || extraction.text || ''),
                settings.limits.maxTextChars
            );

            await emitProgress('analyzing', 72, `Analyzing ${file.name}`);

            file.contentIntelligence = {
                ...(file.contentIntelligence || {}),
                status: 'completed',
                stage: 'completed',
                progress: 100,
                searchableText,
                textExcerpt: truncate(searchableText, 1200),
                textLength: searchableText.length,
                language: analysis.language || null,
                classification: analysis.classification || null,
                tags: uniqueStrings(analysis.tags || [], 20),
                summary: truncate(analysis.summary || '', 1600),
                entities: uniqueStrings(analysis.entities || [], 30),
                provider: analysis.provider || settings.provider.type || 'local',
                model: analysis.model || settings.provider.model || null,
                extractionMethod: extraction.method || null,
                ocrApplied: extraction.ocrApplied === true,
                imageRecognized: analysis.imageRecognized === true,
                error: null,
                manuallyTriggered: manual === true,
                lastRunAt: new Date(),
                completedAt: new Date()
            };
            await file.save();

            return {
                file,
                state: this.serializeState(file, {
                    status: 'completed',
                    stage: 'completed',
                    progress: 100,
                    message: `Content intelligence completed for ${file.name}.`
                })
            };
        } catch (error) {
            file.contentIntelligence = {
                ...(file.contentIntelligence || {}),
                status: 'failed',
                stage: 'failed',
                progress: 0,
                error: error.message || 'Content intelligence failed.',
                manuallyTriggered: manual === true,
                lastRunAt: new Date(),
                completedAt: new Date()
            };
            await file.save().catch(() => null);
            throw error;
        } finally {
            if (jobDir) {
                await fs.remove(jobDir).catch(() => null);
            }
        }
    }

    static async executeWorkerAnalysis(file, filePath, capability, settings) {
        const serviceUrl = String(config.contentIntelligence.serviceUrl || '').replace(/\/+$/, '');
        if (!serviceUrl) {
            throw new Error('Content intelligence service URL is not configured.');
        }

        const fileBuffer = await fs.readFile(filePath);
        const raw = await postRequest(`${serviceUrl}/api/content-intelligence/analyze`, {
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                file: {
                    id: safeId(file._id),
                    name: file.name,
                    path: file.path,
                    mimetype: file.mimetype || mime.getType(file.name || filePath) || 'application/octet-stream',
                    size: file.size || fileBuffer.length,
                    base64: fileBuffer.toString('base64')
                },
                capability,
                settings
            }),
            timeoutMs: config.contentIntelligence.requestTimeoutMs
        });
        const parsed = JSON.parse(raw);

        if (!parsed.success) {
            throw new Error(parsed.error || 'Content intelligence service failed.');
        }

        return parsed;
    }

    static initialize() {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        fileEvents.on(EVENT_TYPES.FILE_UPLOADED, async (data = {}) => {
            try {
                const settings = await this.getSettingsForWorkspace(data.workspaceId);
                if (!settings.enabled || !settings.autoProcessUploads) {
                    return;
                }

                const contentIntelligenceQueue = require('../queues/contentIntelligenceQueue');
                await contentIntelligenceQueue.queueFileExtraction({
                    userId: data.userId,
                    fileId: data.fileId,
                    workspaceId: data.workspaceId,
                    manual: false
                });
            } catch (error) {
                console.error('Failed to queue automatic content intelligence:', error.message);
            }
        });
    }
}

module.exports = ContentIntelligenceService;
