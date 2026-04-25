const Queue = require('bull');
const config = require('../config');
const File = require('../models/fileModel');
const ContentIntelligenceService = require('../services/contentIntelligenceService');
const socket = require('../socket');

const contentIntelligenceQueue = new Queue('content-intelligence', {
    redis: config.virusScanning.redis
});

const activeJobs = new Map();

function normalizeQueueStatus(state) {
    if (state === 'waiting' || state === 'delayed' || state === 'paused') {
        return 'queued';
    }

    if (state === 'active') {
        return 'processing';
    }

    return state || 'processing';
}

function emitToUser(userId, payload) {
    try {
        socket.getIO().to(userId).emit('contentIntelligenceUpdate', payload);
    } catch (error) {
        console.error('Failed to emit content intelligence update:', error);
    }
}

function buildPayload(job, patch = {}) {
    const progress = Math.max(0, Math.min(100, Math.round(patch.progress || 0)));

    return {
        jobId: job.id,
        progressId: job.data.progressId,
        fileId: job.data.fileId,
        fileName: job.data.fileName,
        workspaceId: job.data.workspaceId || null,
        status: patch.status || 'processing',
        stage: patch.stage || patch.status || 'processing',
        progress,
        classification: patch.classification || null,
        tags: patch.tags || [],
        error: patch.error || null,
        message: patch.message || null
    };
}

async function findJob(jobId, progressId) {
    if (jobId) {
        const job = await contentIntelligenceQueue.getJob(jobId);
        if (job) {
            return job;
        }
    }

    if (!progressId) {
        return null;
    }

    const activeEntry = Array.from(activeJobs.entries()).find(([, jobInfo]) => jobInfo.progressId === progressId);
    if (activeEntry) {
        return contentIntelligenceQueue.getJob(activeEntry[0]);
    }

    const jobs = await contentIntelligenceQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
    return jobs.find(currentJob => currentJob.data.progressId === progressId) || null;
}

contentIntelligenceQueue.on('error', (error) => {
    console.error('Content Intelligence Queue Error:', error);
});

contentIntelligenceQueue.on('failed', (job, error) => {
    console.error(`Content intelligence job ${job.id} failed:`, error);
    activeJobs.delete(job.id);
});

contentIntelligenceQueue.on('completed', (job) => {
    activeJobs.delete(job.id);
});

contentIntelligenceQueue.process(async (job) => {
    const { userId, fileId, workspaceId, manual, progressId, fileName } = job.data;
    const activeJob = {
        progressId,
        processTracker: new Set()
    };

    activeJobs.set(job.id, activeJob);

    const emitProgress = (patch) => {
        const data = buildPayload(job, patch);
        emitToUser(userId, data);
        job.progress(data.progress).catch(error => {
            console.error('Failed to update content intelligence progress:', error);
        });
    };

    try {
        emitProgress({
            status: 'queued',
            stage: 'queued',
            progress: 0,
            message: `Queued ${fileName} for content intelligence`
        });

        const result = await ContentIntelligenceService.runFileIntelligence({
            userId,
            fileId,
            workspaceId,
            manual
        }, {
            processTracker: activeJob.processTracker,
            onProgress: emitProgress
        });

        emitProgress({
            ...(result.state || {}),
            status: 'completed',
            stage: 'completed',
            progress: 100,
            message: result.state && result.state.message || `Content intelligence completed for ${fileName}.`
        });

        return result.state;
    } catch (error) {
        emitProgress({
            status: 'failed',
            stage: 'failed',
            progress: 0,
            error: error.message || 'Content intelligence failed.'
        });
        throw error;
    } finally {
        activeJobs.delete(job.id);
    }
});

contentIntelligenceQueue.queueFileExtraction = async ({ userId, fileId, workspaceId = null, manual = true, progressId = null } = {}) => {
    const prepared = await ContentIntelligenceService.prepareQueueRequest(userId, fileId, workspaceId, {
        manual,
        progressId
    });

    emitToUser(userId, prepared.state);

    if (!prepared.queued) {
        return {
            queued: false,
            jobId: null,
            progressId: prepared.progressId,
            ...prepared.state
        };
    }

    const job = await contentIntelligenceQueue.add({
        userId: userId.toString(),
        fileId: prepared.file._id.toString(),
        workspaceId: prepared.workspaceId,
        manual,
        progressId: prepared.progressId,
        fileName: prepared.file.name
    }, {
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 100
    });

    return {
        queued: true,
        jobId: job.id,
        progressId: prepared.progressId,
        ...prepared.state
    };
};

contentIntelligenceQueue.cancelJob = async (jobId, progressId) => {
    const job = await findJob(jobId, progressId);

    if (!job) {
        return false;
    }

    const state = await job.getState();
    const activeJob = activeJobs.get(job.id);

    if (state === 'active' && activeJob) {
        activeJob.processTracker.forEach(child => {
            try {
                child.kill('SIGKILL');
            } catch (error) {
                console.error('Failed to stop content intelligence process:', error.message);
            }
        });
        activeJobs.set(job.id, activeJob);
        await File.findByIdAndUpdate(job.data.fileId, {
            $set: {
                'contentIntelligence.status': 'cancelled',
                'contentIntelligence.stage': 'cancelled',
                'contentIntelligence.progress': 0,
                'contentIntelligence.error': 'Content intelligence cancelled.'
            }
        }).catch(() => null);
        return true;
    }

    await job.remove();
    await File.findByIdAndUpdate(job.data.fileId, {
        $set: {
            'contentIntelligence.status': 'cancelled',
            'contentIntelligence.stage': 'cancelled',
            'contentIntelligence.progress': 0,
            'contentIntelligence.error': 'Content intelligence cancelled.'
        }
    }).catch(() => null);
    emitToUser(job.data.userId, buildPayload(job, {
        status: 'cancelled',
        stage: 'cancelled',
        progress: 0,
        message: 'Content intelligence cancelled.'
    }));
    return true;
};

contentIntelligenceQueue.getStatus = async (jobId) => {
    const job = await contentIntelligenceQueue.getJob(jobId);

    if (!job) {
        return null;
    }

    return {
        jobId: job.id,
        progressId: job.data.progressId,
        fileId: job.data.fileId,
        fileName: job.data.fileName,
        state: await job.getState(),
        progress: await job.progress()
    };
};

contentIntelligenceQueue.getActiveJobsForUser = async (userId) => {
    const normalizedUserId = userId.toString();
    const jobs = await contentIntelligenceQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
    const matchingJobs = jobs.filter(job =>
        job && job.data && job.data.userId && job.data.userId.toString() === normalizedUserId
    );

    return Promise.all(matchingJobs.map(async job => {
        const state = await job.getState();
        const progress = await job.progress();
        const status = normalizeQueueStatus(state);
        const payload = buildPayload(job, {
            status,
            stage: state === 'active' ? 'processing' : status,
            progress
        });

        payload.affectedFiles = [{
            id: job.data.fileId,
            name: job.data.fileName || 'Content intelligence',
            fileName: job.data.fileName || 'Content intelligence',
            status
        }];
        payload.affectedFileCount = payload.affectedFiles.length;
        payload.updatedAt = job.timestamp ? new Date(job.timestamp) : new Date();

        return payload;
    }));
};

module.exports = contentIntelligenceQueue;
