const File = require('../models/fileModel');

function hasTextKey(index) {
    return Object.values(index && index.key || {}).some(value => value === 'text');
}

function sameKeys(existingKey, desiredKey) {
    const existingKeys = Object.keys(existingKey || {});
    const desiredKeys = Object.keys(desiredKey || {});

    return existingKeys.length === desiredKeys.length &&
        desiredKeys.every(key => existingKey[key] === desiredKey[key]);
}

function sameTextDefinition(index, desiredSpec) {
    if (hasTextKey(index)) {
        const weights = index.weights || {};
        const desiredWeights = Object.keys(desiredSpec || {}).reduce((result, key) => {
            result[key] = 1;
            return result;
        }, {});

        return sameKeys(weights, desiredWeights);
    }

    return sameKeys(index && index.key, desiredSpec);
}

async function getExistingIndexes(collection) {
    try {
        return await collection.indexes();
    } catch (error) {
        if (error && (error.code === 26 || error.codeName === 'NamespaceNotFound')) {
            return [];
        }

        throw error;
    }
}

class FileIndexService {
    static async ensureTextSearchIndex() {
        const collection = File.collection;
        const indexName = File.textSearchIndexName;
        const desiredSpec = File.textSearchIndexSpec;
        const desiredOptions = File.textSearchIndexOptions;
        const indexes = await getExistingIndexes(collection);
        const existing = indexes.find(index => index.name === indexName) ||
            indexes.find(index => hasTextKey(index));

        const needsRebuild = !existing ||
            existing.name !== indexName ||
            existing.default_language !== desiredOptions.default_language ||
            existing.language_override !== desiredOptions.language_override ||
            !sameTextDefinition(existing, desiredSpec);

        if (existing && needsRebuild) {
            await collection.dropIndex(existing.name);
        }

        if (needsRebuild) {
            await collection.createIndex(desiredSpec, desiredOptions);
            console.log('File text search index initialized');
        }
    }
}

module.exports = FileIndexService;
