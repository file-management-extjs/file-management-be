const express = require('express');
const cors = require('cors');
const { init } = require('./socket');
const fileRoutes = require('./routes/fileRoutes');
const videoRoutes = require('./routes/videoRoutes');
const imageRoutes = require('./routes/imageRoutes');
const pdfStudioRoutes = require('./routes/pdfStudioRoutes');
const mediaConversionRoutes = require('./routes/mediaConversionRoutes');
const documentConversionRoutes = require('./routes/documentConversionRoutes');
const contentIntelligenceRoutes = require('./routes/contentIntelligenceRoutes');
const publicShareRoutes = require('./routes/publicShareRoutes');
const organizationRoutes = require('./routes/organizationRoutes');
const workspaceRoutes = require('./routes/workspaceRoutes');
const auth = require('./middlewares/auth');
const authRoutes = require('./routes/authRoutes');
const connectDB = require('./config/db');
const http = require('http');
const scheduleAccessTimeout = require('./schedulers/accessTimeoutScheduler');
const ScanningService = require('./services/scanningService');
const ContentIntelligenceService = require('./services/contentIntelligenceService');
const FileIndexService = require('./services/fileIndexService');
require('./queues/mediaConversionQueue');
require('./queues/documentConversionQueue');
require('./queues/contentIntelligenceQueue');

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
    origin: 'http://localhost:8082',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-requested-with',
        'Range',
        'X-File-Id',
        'X-File-Name',
        'X-Chunk-Index',
        'X-Total-Chunks'
    ],
    optionsSuccessStatus: 200
};

// Create an HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = init(server, corsOptions);

app.use(cors(corsOptions));

// Handle preflight requests for all routes
app.options('*', cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
connectDB().then(async () => {
    await FileIndexService.ensureTextSearchIndex();

    // Initialize virus scanning service
    ScanningService.initialize();
    console.log('Virus scanning service initialized');

    ContentIntelligenceService.initialize();
    console.log('Content intelligence service initialized');
    
    // Start the scheduler after database connection is established
    scheduleAccessTimeout();
    
    // Start the server
    server.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to start backend:', err);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit for cancellation errors
    if (!error.cancelled) {
        process.exit(1);
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit for cancellation errors
    if (!reason.cancelled) {
        process.exit(1);
    }
});

// Routes
app.use('/api/public/share', publicShareRoutes);
app.use('/api/files', auth, fileRoutes);
app.use('/api/workspaces', auth, workspaceRoutes);
app.use('/api/organizations', auth, organizationRoutes);
app.use('/api/video', auth, videoRoutes);
app.use('/api/image', auth, imageRoutes);
app.use('/api/pdf-studio', auth, pdfStudioRoutes);
app.use('/api/media-conversion', auth, mediaConversionRoutes);
app.use('/api/document-conversion', auth, documentConversionRoutes);
app.use('/api/content-intelligence', auth, contentIntelligenceRoutes);
app.use('/api/auth', authRoutes);
