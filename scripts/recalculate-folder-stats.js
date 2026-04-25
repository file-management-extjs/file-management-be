const mongoose = require('mongoose');

const connectDB = require('../src/config/db');
const Folder = require('../src/models/folderModel');
const FileService = require('../src/services/fileService');
const StorageInsightsService = require('../src/services/storageInsightsService');

function getFolderDepth(folder) {
    return String(folder.path || '')
        .split(/[\\/]+/)
        .filter(Boolean)
        .length;
}

async function recalculateFolderStats(userId = null) {
    const query = { deleted: false };

    if (userId) {
        query.userId = userId;
    }

    const folders = await Folder.find(query)
        .select('_id parent_id userId path')
        .lean();
    const parentIds = new Set(
        folders
            .map(folder => folder.parent_id)
            .filter(Boolean)
            .map(parentId => parentId.toString())
    );
    const leafFolders = folders.filter(folder => !parentIds.has(folder._id.toString()));
    const startFolders = (leafFolders.length ? leafFolders : folders)
        .sort((first, second) => getFolderDepth(second) - getFolderDepth(first));
    const affectedUserIds = new Set();

    for (let index = 0; index < startFolders.length; index += 1) {
        const folder = startFolders[index];

        await FileService.recalculateFolderStats(folder._id);

        if (folder.userId) {
            affectedUserIds.add(folder.userId.toString());
        }

        if ((index + 1) % 25 === 0) {
            console.log(`Recalculated ${index + 1} of ${startFolders.length} folder branches...`);
        }
    }

    affectedUserIds.forEach(affectedUserId => StorageInsightsService.invalidateUser(affectedUserId));

    return {
        folderCount: folders.length,
        recalculatedBranches: startFolders.length,
        userCount: affectedUserIds.size
    };
}

async function main() {
    const userId = process.argv[2] || null;

    if (!process.env.MONGODB_URI) {
        console.error('MONGODB_URI is required.');
        process.exit(1);
    }

    await connectDB();

    const result = await recalculateFolderStats(userId);

    console.log(
        `Folder stats recalculated: ${result.folderCount} folders, ` +
        `${result.recalculatedBranches} branches, ${result.userCount} users.`
    );

    await mongoose.disconnect();
}

main().catch(async error => {
    console.error('Failed to recalculate folder stats:', error);

    try {
        await mongoose.disconnect();
    } catch (disconnectError) {
        console.error('Failed to disconnect from MongoDB:', disconnectError);
    }

    process.exit(1);
});
