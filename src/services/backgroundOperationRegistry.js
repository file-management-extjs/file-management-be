const operations = new Map();
const retentionTimers = new Map();
const TERMINAL_RETENTION_MS = 30000;

function normalizeId(value) {
    return value === undefined || value === null ? '' : value.toString();
}

function getKey(operation) {
    return operation.progressId || operation.id || `${operation.type || 'operation'}-${Date.now()}`;
}

function scheduleRemoval(key) {
    if (retentionTimers.has(key)) {
        clearTimeout(retentionTimers.get(key));
    }

    retentionTimers.set(key, setTimeout(() => {
        operations.delete(key);
        retentionTimers.delete(key);
    }, TERMINAL_RETENTION_MS));
}

module.exports = {
    start(operation = {}) {
        const key = getKey(operation);
        const now = new Date();
        const nextOperation = {
            id: key,
            progressId: operation.progressId || key,
            jobId: operation.jobId || null,
            userId: normalizeId(operation.userId),
            type: operation.type || 'Background Job',
            title: operation.title || 'Background operation',
            detail: operation.detail || '',
            status: operation.status || 'running',
            statusText: operation.statusText || 'Running',
            progress: Number(operation.progress) || 0,
            affectedFiles: Array.isArray(operation.affectedFiles) ? operation.affectedFiles : [],
            createdAt: operation.createdAt || now,
            updatedAt: now
        };

        operations.set(key, nextOperation);
        return nextOperation;
    },

    update(progressId, patch = {}) {
        const key = getKey({ progressId });
        const current = operations.get(key);
        if (!current) {
            return null;
        }

        const nextOperation = {
            ...current,
            ...patch,
            progress: patch.progress !== undefined ? Number(patch.progress) || 0 : current.progress,
            affectedFiles: Array.isArray(patch.affectedFiles) ? patch.affectedFiles : current.affectedFiles,
            updatedAt: new Date()
        };

        operations.set(key, nextOperation);
        return nextOperation;
    },

    complete(progressId, patch = {}) {
        const operation = this.update(progressId, {
            ...patch,
            status: patch.status || 'completed',
            statusText: patch.statusText || 'Completed',
            progress: patch.progress !== undefined ? patch.progress : 100
        });

        if (operation) {
            scheduleRemoval(operation.id);
        }

        return operation;
    },

    fail(progressId, patch = {}) {
        const operation = this.update(progressId, {
            ...patch,
            status: patch.status || 'failed',
            statusText: patch.statusText || 'Failed'
        });

        if (operation) {
            scheduleRemoval(operation.id);
        }

        return operation;
    },

    list(userId) {
        const normalizedUserId = normalizeId(userId);

        return Array.from(operations.values()).filter(operation =>
            operation.userId === normalizedUserId
        );
    }
};
