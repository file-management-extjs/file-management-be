const Queue = require('bull');
const config = require('../config');
const DocumentConversionService = require('../services/documentConversionService');
const socket = require('../socket');

const documentConversionQueue = new Queue('document-conversion', {
    redis: config.virusScanning.redis
});

const activeJobs = new Map();

function normalizeQueueStatus(state) {
    if (state === 'waiting' || state === 'delayed' || state === 'paused') {
        return 'queued';
    }

    if (state === 'active') {
        return 'running';
    }

    return state || 'running';
}

function emitToUser(userId, payload) {
    try {
        socket.getIO().to(userId).emit('documentConversionUpdate', payload);
    } catch (error) {
        console.error('Failed to emit document conversion update:', error);
    }
}

function buildPayload(job, patch = {}) {
    const progress = Math.max(0, Math.min(100, Math.round(patch.progress || 0)));

    return {
        jobId: job.id,
        progressId: job.data.progressId,
        fileName: job.data.batchLabel,
        targetFormat: job.data.targetFormat,
        currentFileName: patch.currentFileName || null,
        status: patch.status || 'running',
        stage: patch.stage || patch.status || 'running',
        progress,
        files: patch.files || [],
        error: patch.error || null,
        message: patch.message || null
    };
}

async function findJob(jobId, progressId) {
    if (jobId) {
        const job = await documentConversionQueue.getJob(jobId);
        if (job) {
            return job;
        }
    }

    if (!progressId) {
        return null;
    }

    const activeEntry = Array.from(activeJobs.entries()).find(([, jobInfo]) => jobInfo.progressId === progressId);
    if (activeEntry) {
        return documentConversionQueue.getJob(activeEntry[0]);
    }

    const jobs = await documentConversionQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
    return jobs.find(currentJob => currentJob.data.progressId === progressId) || null;
}

documentConversionQueue.on('error', (error) => {
    console.error('Document Conversion Queue Error:', error);
});

documentConversionQueue.on('failed', (job, error) => {
    console.error(`Document conversion job ${job.id} failed:`, error);
    activeJobs.delete(job.id);
});

documentConversionQueue.on('completed', (job) => {
    activeJobs.delete(job.id);
});

documentConversionQueue.process(async (job) => {
    const { userId, payload, progressId } = job.data;
    const activeJob = {
        cancelled: false,
        progressId,
        processTracker: new Set()
    };

    activeJobs.set(job.id, activeJob);

    const emitProgress = (patch) => {
        const data = buildPayload(job, patch);
        emitToUser(userId, data);
        job.progress(data.progress).catch(error => {
            console.error('Failed to update document conversion progress:', error);
        });
    };

    try {
        emitProgress({
            status: 'running',
            stage: 'queued',
            progress: 0,
            message: `Queued ${job.data.batchLabel} for document conversion`
        });

        const result = await DocumentConversionService.execute(userId, payload, {
            processTracker: activeJob.processTracker,
            isCancelled: () => activeJobs.get(job.id)?.cancelled === true,
            onProgress: emitProgress
        });

        if (activeJobs.get(job.id)?.cancelled) {
            emitProgress({
                status: 'cancelled',
                stage: 'cancelled',
                progress: 0,
                message: 'Document conversion cancelled.'
            });
            return null;
        }

        emitProgress({
            status: 'completed',
            stage: 'completed',
            progress: 100,
            files: result.files || [],
            message: result.message
        });

        return result;
    } catch (error) {
        if (error.cancelled) {
            emitProgress({
                status: 'cancelled',
                stage: 'cancelled',
                progress: 0,
                message: 'Document conversion cancelled.'
            });
            return null;
        }

        emitProgress({
            status: 'failed',
            stage: 'failed',
            progress: 0,
            error: error.message || 'Document conversion failed.'
        });
        throw error;
    } finally {
        activeJobs.delete(job.id);
    }
});

documentConversionQueue.cancelJob = async (jobId, progressId) => {
    const job = await findJob(jobId, progressId);

    if (!job) {
        return false;
    }

    const state = await job.getState();
    const activeJob = activeJobs.get(job.id);

    if (state === 'active' && activeJob) {
        activeJob.cancelled = true;
        activeJob.processTracker.forEach(child => {
            try {
                child.kill('SIGKILL');
            } catch (error) {
                console.error('Failed to stop document conversion process:', error.message);
            }
        });
        activeJobs.set(job.id, activeJob);
        return true;
    }

    await job.remove();
    emitToUser(job.data.userId, buildPayload(job, {
        status: 'cancelled',
        stage: 'cancelled',
        progress: 0,
        message: 'Document conversion cancelled.'
    }));
    return true;
};

documentConversionQueue.getStatus = async (jobId) => {
    const job = await documentConversionQueue.getJob(jobId);

    if (!job) {
        return null;
    }

    return {
        jobId: job.id,
        progressId: job.data.progressId,
        fileName: job.data.batchLabel,
        state: await job.getState(),
        progress: await job.progress()
    };
};

documentConversionQueue.getActiveJobsForUser = async (userId) => {
    const normalizedUserId = userId.toString();
    const jobs = await documentConversionQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
    const matchingJobs = jobs.filter(job =>
        job && job.data && job.data.userId && job.data.userId.toString() === normalizedUserId
    );

    return Promise.all(matchingJobs.map(async job => {
        const state = await job.getState();
        const progress = await job.progress();
        const status = normalizeQueueStatus(state);
        const payload = buildPayload(job, {
            status,
            stage: state === 'active' ? 'running' : status,
            progress
        });

        payload.affectedFiles = [{
            name: job.data.batchLabel || 'Document conversion',
            fileName: job.data.batchLabel || 'Document conversion',
            status
        }];
        payload.affectedFileCount = payload.affectedFiles.length;
        payload.updatedAt = job.timestamp ? new Date(job.timestamp) : new Date();

        return payload;
    }));
};

module.exports = documentConversionQueue;
