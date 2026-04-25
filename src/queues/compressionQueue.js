const Queue = require('bull');
const FileService = require('../services/fileService');
const socket = require('../socket');

// Redis connection configuration
const redisConfig = {
    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        }
    }
};

// Create compression queue
const compressionQueue = new Queue('compression', redisConfig);

// Track active jobs and their cancel status
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

function buildAffectedFiles(job) {
    const affectedItems = Array.isArray(job.data.affectedItems) ? job.data.affectedItems : [];
    if (affectedItems.length) {
        return affectedItems.map(item => ({
            name: item.name || item.fileName || 'Selected item',
            fileName: item.fileName || item.name || 'Selected item',
            size: item.size || null,
            type: item.type || '',
            path: item.path || '',
            status: 'Queued'
        }));
    }

    return (job.data.items || []).map(item => ({
        name: typeof item === 'string' ? item : (item.name || item.id || 'Selected item'),
        fileName: typeof item === 'string' ? item : (item.name || item.id || 'Selected item'),
        status: 'Queued'
    }));
}

// Handle queue errors
compressionQueue.on('error', (error) => {
    console.error('Compression Queue Error:', error);
});

compressionQueue.on('failed', (job, error) => {
    console.error(`Job ${job.id} failed:`, error);
    activeJobs.delete(job.id);
});

compressionQueue.on('completed', (job) => {
    activeJobs.delete(job.id);
});

// Process compression jobs
compressionQueue.process(async (job) => {
    const { userId, items, folder, zipFileName, parentId, archiveType, compressionLevel, progressId, workspaceId } = job.data;
    console.log('Processing compression job:', {
        jobId: job.id,
        progressId,
        zipFileName
    });

    // Add job to active jobs map
    activeJobs.set(job.id, {
        cancelled: false,
        progressId
    });

    let cleanup = false;
    try {
        // Create progress callback that emits to socket
        const progressCallback = (progress) => {
            try {
                // Check if job was cancelled
                const jobInfo = activeJobs.get(job.id);
                if (jobInfo && jobInfo.cancelled) {
                    cleanup = true; // Mark for cleanup
                    const error = new Error('Job cancelled by user');
                    error.cancelled = true; // Mark error as cancellation
                    throw error;
                }

                const io = socket.getIO();
                io.to(userId).emit('compressionProgress', {
                    jobId: job.id,
                    fileName: zipFileName,
                    progress,
                    progressId
                });
                job.progress(progress);
            } catch (err) {
                if (err.cancelled) {
                    throw err; // Re-throw cancellation errors
                }
                console.error('Failed to emit compression progress:', err);
            }
        };

        // Execute compression
        const result = await FileService.compressFiles(
            userId,
            items,
            folder,
            zipFileName,
            parentId,
            progressCallback,
            archiveType,
            compressionLevel,
            { workspaceId }
        );

        // Emit completion event if not cancelled
        const jobInfo = activeJobs.get(job.id);
        if (!jobInfo?.cancelled) {
            try {
                const io = socket.getIO();
                io.to(userId).emit('compressionComplete', {
                    jobId: job.id,
                    fileName: zipFileName,
                    success: true,
                    file: result.file,
                    progressId
                });
            } catch (err) {
                console.error('Failed to emit compression complete:', err);
            }
        }

        return result;
    } catch (error) {
        if (error.cancelled) {
            console.log('Compression cancelled:', {
                jobId: job.id,
                fileName: zipFileName
            });
            try {
                const io = socket.getIO();
                io.to(userId).emit('compressionCancelled', {
                    jobId: job.id,
                    fileName: zipFileName,
                    progressId
                });
            } catch (err) {
                console.error('Failed to emit compression cancelled:', err);
            }
            return null; // Return null for cancelled jobs
        }

        console.error('Error in compression:', error);
        try {
            const io = socket.getIO();
            io.to(userId).emit('compressionError', {
                jobId: job.id,
                fileName: zipFileName,
                error: error.message,
                progressId
            });
        } catch (err) {
            console.error('Failed to emit compression error:', err);
        }
        throw error; // Re-throw non-cancellation errors
    } finally {
        // Only clean up if not cancelled or if marked for cleanup
        if (!activeJobs.get(job.id)?.cancelled || cleanup) {
            activeJobs.delete(job.id);
        }
    }
});

// Function to mark a job as cancelled
compressionQueue.cancelJob = async (jobId, progressId) => {
    let job = null;

    try {
        // First try to find by Bull's job ID
        if (jobId) {
            job = await compressionQueue.getJob(jobId);
        }
        
        // If not found and progressId provided, search active jobs
        if (!job && progressId) {
            for (const [activeJobId, jobInfo] of activeJobs) {
                if (jobInfo.progressId === progressId) {
                    job = await compressionQueue.getJob(activeJobId);
                    break;
                }
            }
        }

        // If still not found, search queued jobs by progressId
        if (!job && progressId) {
            const queuedJobs = await compressionQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
            job = queuedJobs.find(queuedJob => queuedJob.data.progressId === progressId) || null;
        }

        if (!job) {
            console.log('No job found:', { jobId, progressId });
            return false;
        }

        // Get job state
        const state = await job.getState();
        console.log('Found job to cancel:', { jobId: job.id, state });

        // If job is active, just mark it for cancellation
        if (state === 'active') {
            const jobInfo = activeJobs.get(job.id);
            if (jobInfo) {
                jobInfo.cancelled = true;
                activeJobs.set(job.id, jobInfo);
                console.log('Marked active job as cancelled:', job.id);
                return true;
            }
        } else {
            // For non-active jobs, we can remove them from the queue
            try {
                await job.remove();
                console.log('Removed job from queue:', job.id);
                return true;
            } catch (err) {
                console.error('Error removing job from queue:', err);
                // Even if remove fails, we can still mark it as cancelled
                const jobInfo = activeJobs.get(job.id);
                if (jobInfo) {
                    jobInfo.cancelled = true;
                    activeJobs.set(job.id, jobInfo);
                    console.log('Marked job as cancelled after failed remove:', job.id);
                    return true;
                }
            }
        }

        return false;
    } catch (error) {
        console.error('Error in cancelJob:', error);
        // If anything fails, try to mark the job as cancelled if it's in activeJobs
        if (job && activeJobs.has(job.id)) {
            const jobInfo = activeJobs.get(job.id);
            jobInfo.cancelled = true;
            activeJobs.set(job.id, jobInfo);
            console.log('Marked job as cancelled after error:', job.id);
            return true;
        }
        return false;
    }
};

compressionQueue.getActiveJobsForUser = async (userId) => {
    const normalizedUserId = userId.toString();
    const jobs = await compressionQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);

    const matchingJobs = jobs.filter(job =>
        job && job.data && job.data.userId && job.data.userId.toString() === normalizedUserId
    );

    return Promise.all(matchingJobs.map(async job => {
        const state = await job.getState();
        const progress = await job.progress();
        const affectedFiles = buildAffectedFiles(job);

        return {
            jobId: job.id,
            progressId: job.data.progressId,
            fileName: job.data.zipFileName || 'Archive',
            title: `Compressing ${job.data.zipFileName || 'archive'}`,
            activityType: 'Compression',
            status: normalizeQueueStatus(state),
            stage: state,
            progress: Number(progress) || 0,
            affectedFiles,
            affectedFileCount: affectedFiles.length,
            updatedAt: job.timestamp ? new Date(job.timestamp) : new Date()
        };
    }));
};

module.exports = compressionQueue;
