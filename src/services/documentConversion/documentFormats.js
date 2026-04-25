const path = require('path');
const mime = require('mime');

const TARGET_FORMATS = {
    pdf: {
        value: 'pdf',
        label: 'PDF',
        extension: '.pdf',
        mimeType: 'application/pdf',
        description: 'Portable document with layout preserved through LibreOffice.'
    },
    webhtml: {
        value: 'webhtml',
        label: 'HTML Web Preview',
        extension: '.html',
        mimeType: 'text/html',
        description: 'Self-contained HTML preview built from page renderings for browser viewing.'
    },
    docx: {
        value: 'docx',
        label: 'Word DOCX',
        extension: '.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        description: 'Editable Word document.'
    },
    xlsx: {
        value: 'xlsx',
        label: 'Excel XLSX',
        extension: '.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        description: 'Spreadsheet workbook.'
    },
    pptx: {
        value: 'pptx',
        label: 'PowerPoint PPTX',
        extension: '.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        description: 'Presentation deck.'
    },
    txt: {
        value: 'txt',
        label: 'Plain Text TXT',
        extension: '.txt',
        mimeType: 'text/plain',
        description: 'Plain text extraction.'
    },
    md: {
        value: 'md',
        label: 'Markdown MD',
        extension: '.md',
        mimeType: 'text/markdown',
        description: 'Markdown text output.'
    },
    rtf: {
        value: 'rtf',
        label: 'Rich Text RTF',
        extension: '.rtf',
        mimeType: 'application/rtf',
        description: 'Rich text document.'
    },
    csv: {
        value: 'csv',
        label: 'CSV',
        extension: '.csv',
        mimeType: 'text/csv',
        description: 'Comma-separated text rows.'
    }
};

function getMimeType(file) {
    return String(file && (file.mimetype || mime.getType(file.name)) || '').toLowerCase();
}

function getExtension(file) {
    return path.extname(String(file && file.name || '')).toLowerCase();
}

function isPdf(file) {
    return getMimeType(file) === 'application/pdf' || getExtension(file) === '.pdf';
}

function isWordDocument(file) {
    const mimeType = getMimeType(file);
    const extension = getExtension(file);

    return mimeType.includes('word') ||
        mimeType.includes('opendocument.text') ||
        ['.doc', '.docx', '.odt', '.rtf'].includes(extension);
}

function isSpreadsheetDocument(file) {
    const mimeType = getMimeType(file);
    const extension = getExtension(file);

    return mimeType.includes('excel') ||
        mimeType.includes('spreadsheet') ||
        mimeType === 'text/csv' ||
        ['.xls', '.xlsx', '.ods', '.csv'].includes(extension);
}

function isPresentationDocument(file) {
    const mimeType = getMimeType(file);
    const extension = getExtension(file);

    return mimeType.includes('powerpoint') ||
        mimeType.includes('presentation') ||
        mimeType.includes('opendocument.presentation') ||
        ['.ppt', '.pptx', '.odp'].includes(extension);
}

function isMarkdownDocument(file) {
    const mimeType = getMimeType(file);
    const extension = getExtension(file);

    return mimeType === 'text/markdown' || ['.md', '.markdown'].includes(extension);
}

function isHtmlDocument(file) {
    const mimeType = getMimeType(file);
    const extension = getExtension(file);

    return mimeType === 'text/html' ||
        mimeType === 'application/xhtml+xml' ||
        ['.html', '.htm', '.xhtml'].includes(extension);
}

function isPlainTextDocument(file) {
    const mimeType = getMimeType(file);
    const extension = getExtension(file);

    return mimeType === 'text/plain' || extension === '.txt';
}

function isConvertibleDocument(file) {
    return isPdf(file) ||
        isWordDocument(file) ||
        isSpreadsheetDocument(file) ||
        isPresentationDocument(file) ||
        isMarkdownDocument(file) ||
        isHtmlDocument(file) ||
        isPlainTextDocument(file);
}

function getAllowedTargetFormats(file) {
    const extension = getExtension(file);

    if (isPdf(file)) {
        return ['docx', 'xlsx', 'pptx', 'txt', 'md', 'rtf', 'csv', 'webhtml'];
    }

    if (isWordDocument(file)) {
        const formats = ['pdf', 'webhtml', 'txt', 'md'];

        if (extension !== '.rtf') {
            formats.push('rtf');
        }

        if (extension !== '.docx') {
            formats.push('docx');
        }

        return formats;
    }

    if (isSpreadsheetDocument(file)) {
        const formats = ['pdf', 'webhtml'];

        if (extension !== '.xlsx') {
            formats.push('xlsx');
        }

        if (extension !== '.csv') {
            formats.push('csv');
        }

        return formats;
    }

    if (isPresentationDocument(file)) {
        const formats = ['pdf', 'webhtml'];

        if (extension !== '.pptx') {
            formats.push('pptx');
        }

        return formats;
    }

    if (isMarkdownDocument(file)) {
        return ['pdf', 'webhtml', 'docx', 'txt', 'rtf'];
    }

    if (isHtmlDocument(file)) {
        return ['pdf', 'webhtml', 'docx', 'txt', 'md', 'rtf'];
    }

    if (isPlainTextDocument(file)) {
        return ['pdf', 'webhtml', 'docx', 'md', 'rtf'];
    }

    return [];
}

function intersectAllowedTargetFormats(files) {
    if (!Array.isArray(files) || !files.length) {
        return [];
    }

    return files.reduce((intersection, file) => {
        const allowed = getAllowedTargetFormats(file);

        if (!intersection) {
            return allowed.slice();
        }

        return intersection.filter(format => allowed.includes(format));
    }, null) || [];
}

function listTargetFormats() {
    return Object.values(TARGET_FORMATS).map(target => ({
        value: target.value,
        label: target.label,
        extension: target.extension,
        mimeType: target.mimeType,
        description: target.description
    }));
}

module.exports = {
    TARGET_FORMATS,
    getMimeType,
    getExtension,
    isPdf,
    isWordDocument,
    isSpreadsheetDocument,
    isPresentationDocument,
    isMarkdownDocument,
    isHtmlDocument,
    isPlainTextDocument,
    isConvertibleDocument,
    getAllowedTargetFormats,
    intersectAllowedTargetFormats,
    listTargetFormats
};
