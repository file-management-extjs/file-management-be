const File = require('../models/fileModel');  // Correct model path
const FileService = require('./fileService');

class VideoService {
    static async getVideoDetails(fileId) {
        const video = await File.findById(fileId);
        
        if (!video) return null;

        return {
            file: video,
            size: video.size || await FileService.getStoredFileSize(video),
            mimetype: video.mimetype || 'video/mp4'
        };
    }
}

module.exports = VideoService;
