const VideoService = require('../services/videoService');
const FileService = require('../services/fileService');

exports.streamVideo = async (req, res) => {
    const { fileId } = req.params;

    // Fetch Video Stream
    const video = await VideoService.getVideoDetails(fileId);  // Fetch file details
    if (!video) {
        return res.status(404).send('Video not found');
    }

    const videoSize = video.size;
    const range = req.headers.range;

    if (!range) {
        // Full Content Response
        const headers = {
            'Content-Length': videoSize,
            'Content-Type': video.mimetype,
        };
        res.writeHead(200, headers);
        const { stream } = await FileService.getFileStream(video.file);
        stream.pipe(res);
        return;
    }

    // Partial Content Response
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : videoSize - 1;

    if (start >= videoSize || end >= videoSize) {
        res.status(416).send('Requested range not satisfiable');
        return;
    }

    const chunkSize = end - start + 1;
    const { stream: videoStream } = await FileService.getFileStream(video.file, { start, end });

    const headers = {
        'Content-Range': `bytes ${start}-${end}/${videoSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': video.mimetype,
    };

    res.writeHead(206, headers);  // Status 206: Partial Content
    videoStream.pipe(res);
};
