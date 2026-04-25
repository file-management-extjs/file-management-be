const Queue = require('bull');
const config = require('../config');
const MediaConversionService = require('../services/mediaConversionService');
const socket = require('../socket');

const mediaConversionQueue = new Queue('media-conversion', {
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
        socket.getIO().to(userId).emit('mediaConversionUpdate', payload);
    } catch (error) {
        console.error('Failed to emit media conversion update:', error);
    }
}

function buildPayload(job, patch = {}) {
    const progress = Math.max(0, Math.min(100, Math.round(patch.progress || 0)));

    return {
        jobId: job.id,
        progressId: job.data.progressId,
        fileName: job.data.fileName,
        outputFileName: job.data.payload?.outputFileName || null,
        operation: job.data.payload?.operation || null,
        status: patch.status || 'running',
        stage: patch.stage || patch.status || 'running',
        progress,
        converterProgress: patch.converterProgress,
        converterJobId: patch.converterJobId,
        files: patch.files || [],
        error: patch.error || null,
        message: patch.message || null
    };
}

async function findJob(jobId, progressId) {
    if (jobId) {
        const job = await mediaConversionQueue.getJob(jobId);
        if (job) {
            return job;
        }
    }

    if (progressId) {
        const activeEntry = Array.from(activeJobs.entries()).find(([, jobInfo]) => jobInfo.progressId === progressId);
        if (activeEntry) {
            return await mediaConversionQueue.getJob(activeEntry[0]);
        }

        const jobs = await mediaConversionQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
        return jobs.find(currentJob => currentJob.data.progressId === progressId) || null;
    }

    return null;
}

mediaConversionQueue.on('error', (error) => {
    console.error('Media Conversion Queue Error:', error);
});

mediaConversionQueue.on('failed', (job, error) => {
    console.error(`Media conversion job ${job.id} failed:`, error);
    activeJobs.delete(job.id);
});

mediaConversionQueue.on('completed', (job) => {
    activeJobs.delete(job.id);
});

mediaConversionQueue.process(async (job) => {
    const { userId, payload, progressId, fileName } = job.data;
    const activeJob = {
        cancelled: false,
        progressId,
        converterJobId: null
    };

    activeJobs.set(job.id, activeJob);

    const emitProgress = (patch) => {
        const data = buildPayload(job, patch);
        emitToUser(userId, data);
        job.progress(data.progress).catch(error => {
            console.error('Failed to update media conversion job progress:', error);
        });
    };

    try {
        emitProgress({
            status: 'running',
            stage: 'queued',
            progress: 0,
            message: `Queued ${fileName} for media conversion`
        });

        const result = await MediaConversionService.execute(userId, payload, {
            onProgress: emitProgress,
            isCancelled: () => activeJobs.get(job.id)?.cancelled === true,
            onConverterJob: converterJobId => {
                activeJob.converterJobId = converterJobId;
                activeJobs.set(job.id, activeJob);
            },
            getConverterJobId: () => activeJobs.get(job.id)?.converterJobId || null
        });

        if (activeJobs.get(job.id)?.cancelled) {
            emitProgress({
                status: 'cancelled',
                stage: 'cancelled',
                progress: 0,
                message: 'Media conversion cancelled.'
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
                message: 'Media conversion cancelled.'
            });
            return null;
        }

        emitProgress({
            status: 'failed',
            stage: 'failed',
            progress: 0,
            error: error.message || 'Media conversion failed.'
        });

        throw error;
    } finally {
        activeJobs.delete(job.id);
    }
});

mediaConversionQueue.cancelJob = async (jobId, progressId) => {
    const job = await findJob(jobId, progressId);

    if (!job) {
        return false;
    }

    const state = await job.getState();
    const activeJob = activeJobs.get(job.id);

    if (state === 'active' && activeJob) {
        activeJob.cancelled = true;
        activeJobs.set(job.id, activeJob);
        await MediaConversionService.cancelConverterJob(activeJob.converterJobId);
        return true;
    }

    await job.remove();
    emitToUser(job.data.userId, buildPayload(job, {
        status: 'cancelled',
        stage: 'cancelled',
        progress: 0,
        message: 'Media conversion cancelled.'
    }));
    return true;
};

mediaConversionQueue.getStatus = async (jobId) => {
    const job = await mediaConversionQueue.getJob(jobId);

    if (!job) {
        return null;
    }

    return {
        jobId: job.id,
        progressId: job.data.progressId,
        fileName: job.data.fileName,
        state: await job.getState(),
        progress: await job.progress()
    };
};

mediaConversionQueue.getActiveJobsForUser = async (userId) => {
    const normalizedUserId = userId.toString();
    const jobs = await mediaConversionQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
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
            name: job.data.fileName || 'Media conversion',
            fileName: job.data.fileName || 'Media conversion',
            status
        }];
        payload.affectedFileCount = payload.affectedFiles.length;
        payload.updatedAt = job.timestamp ? new Date(job.timestamp) : new Date();

        return payload;
    }));
};

module.exports = mediaConversionQueue;
