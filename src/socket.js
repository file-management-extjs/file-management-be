// socket.js
let io;

module.exports = {
    init: (server, corsOptions) => {
        if (io) {
            throw new Error('Socket.IO is already initialized!');
        }
        io = require('socket.io')(server, {
            cors: corsOptions,
        });

        // Authentication middleware
        io.use(async (socket, next) => {
            const token = socket.handshake.auth.token;
            if (!token) {
                return next(new Error('Authentication error: Token missing'));
            }

            try {
                const jwt = require('jsonwebtoken');
                const User = require('./models/userModel');
                const payload = jwt.verify(token, process.env.JWT_SECRET);
                const user = await User.findById(payload.userId).select('_id sessionVersion').lean();
                const tokenSessionVersion = Number(payload.sessionVersion || 0);
                const currentSessionVersion = Number(user && user.sessionVersion || 0);

                if (!user || tokenSessionVersion !== currentSessionVersion) {
                    return next(new Error('Authentication error: Session logged out'));
                }

                socket.userId = payload.userId;
                next();
            } catch (err) {
                return next(new Error('Authentication error: Invalid token'));
            }
        });

        // Socket event handlers
        io.on('connection', (socket) => {
            console.log('A user connected:', socket.id);

            socket.on('joinRoom', (userId) => {
                socket.join(userId);
                console.log(`User ${socket.id} joined room ${userId}`);
            });

            socket.on('cancelOperation', async (data) => {
                const { jobId, progressId, operationType } = data;
                const compressionQueue = require('./queues/compressionQueue');
                const mediaConversionQueue = require('./queues/mediaConversionQueue');
                const documentConversionQueue = require('./queues/documentConversionQueue');
                const contentIntelligenceQueue = require('./queues/contentIntelligenceQueue');
                
                try {
                    let cancelled = false;

                    if (operationType === 'mediaConversion') {
                        cancelled = await mediaConversionQueue.cancelJob(jobId, progressId);
                    } else if (operationType === 'documentConversion') {
                        cancelled = await documentConversionQueue.cancelJob(jobId, progressId);
                    } else if (operationType === 'contentIntelligence') {
                        cancelled = await contentIntelligenceQueue.cancelJob(jobId, progressId);
                    } else {
                        cancelled = await compressionQueue.cancelJob(jobId, progressId);

                        if (!cancelled) {
                            cancelled = await mediaConversionQueue.cancelJob(jobId, progressId);
                        }

                        if (!cancelled) {
                            cancelled = await documentConversionQueue.cancelJob(jobId, progressId);
                        }

                        if (!cancelled) {
                            cancelled = await contentIntelligenceQueue.cancelJob(jobId, progressId);
                        }
                    }

                    if (cancelled) {
                        socket.emit('operationCancelled', {
                            jobId,
                            progressId,
                            message: 'Operation cancelled successfully'
                        });
                    } else {
                        socket.emit('operationCancelError', {
                            jobId,
                            progressId,
                            error: 'Operation not found or already completed'
                        });
                    }
                } catch (error) {
                    console.error('Error cancelling operation:', error);
                    socket.emit('operationCancelError', {
                        jobId,
                        progressId,
                        error: 'Failed to cancel operation: ' + error.message
                    });
                }
            });
        });

        return io;
    },

    getIO: () => {
        if (!io) {
            throw new Error('Socket.IO is not initialized!');
        }
        return io;
    }
};
