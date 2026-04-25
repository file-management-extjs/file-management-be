const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime');
const sharp = require('sharp');
const File = require('../models/fileModel');
const FileService = require('./fileService');
const StorageService = require('./storage/storageService');

class PdfStudioService {
    static commandTimeoutMs = parseInt(process.env.PDF_STUDIO_COMMAND_TIMEOUT_MS || `${5 * 60 * 1000}`, 10);

    static supportedOperations = [
        'merge',
        'split',
        'extract',
        'reorder',
        'rotate',
        'compress',
        'watermark',
        'protect',
        'decorate',
        'convert',
        'create'
    ];

    static pdfcpuImportImageExtensions = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'];

    static createError(message, statusCode = 400) {
        const error = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    static isPdf(file) {
        return (file.mimetype || mime.getType(file.name) || '') === 'application/pdf' ||
            path.extname(file.name || '').toLowerCase() === '.pdf';
    }

    static isImage(file) {
        return String(file.mimetype || mime.getType(file.name) || '').startsWith('image/');
    }

    static async prepareImageForPdfImport(entry, workRoot, index) {
        const extension = path.extname(entry.sourcePath || entry.file.name || '').toLowerCase();

        if (this.pdfcpuImportImageExtensions.includes(extension)) {
            return entry.sourcePath;
        }

        const outputDir = path.join(workRoot, 'pdf-import-images');
        const baseName = this.sanitizeFilename(
            path.basename(entry.file.name || `image-${index + 1}`, path.extname(entry.file.name || '')),
            `image-${index + 1}`
        );
        const outputPath = path.join(outputDir, `${baseName}-${index + 1}.png`);

        await fs.ensureDir(outputDir);

        try {
            await sharp(entry.sourcePath)
                .png()
                .toFile(outputPath);
        } catch (error) {
            throw this.createError(`Cannot convert image "${entry.file.name}" to a PDF-supported image format.`, 422);
        }

        return outputPath;
    }

    static isTextLike(file) {
        const mimeType = String(file.mimetype || mime.getType(file.name) || '');
        return mimeType.startsWith('text/') ||
            [
                'application/json',
                'application/xml',
                'application/javascript'
            ].includes(mimeType);
    }

    static isOfficeDocument(file) {
        const mimeType = String(file.mimetype || mime.getType(file.name) || '');
        const extension = path.extname(file.name || '').toLowerCase();

        return mimeType.includes('word') ||
            mimeType.includes('excel') ||
            mimeType.includes('powerpoint') ||
            mimeType.includes('spreadsheet') ||
            mimeType.includes('presentation') ||
            ['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp'].includes(extension);
    }

    static sanitizeFilename(filename, fallback = 'pdf-studio-output') {
        const base = path.basename(String(filename || fallback)).trim();
        const sanitized = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        return sanitized || fallback;
    }

    static ensureExtension(filename, extension) {
        const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
        const sanitized = this.sanitizeFilename(filename, `pdf-studio-output${normalizedExtension}`);
        return sanitized.toLowerCase().endsWith(normalizedExtension.toLowerCase())
            ? sanitized
            : `${sanitized}${normalizedExtension}`;
    }

    static outputName(baseName, suffix, extension) {
        const normalizedBase = path.basename(baseName || 'document', path.extname(baseName || 'document'));
        return this.ensureExtension(`${normalizedBase}-${suffix}-${Date.now()}`, extension);
    }

    static normalizePageSelection(pages) {
        return String(pages || '').trim();
    }

    static requirePages(pages, label = 'Pages') {
        const selectedPages = this.normalizePageSelection(pages);
        if (!selectedPages) {
            throw this.createError(`${label} are required.`);
        }

        return selectedPages;
    }

    static runCommand(command, args, options = {}) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                cwd: options.cwd,
                env: {
                    ...process.env,
                    HOME: options.home || process.env.HOME || '/tmp'
                }
            });

            let stdout = '';
            let stderr = '';
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) {
                    return;
                }

                settled = true;
                child.kill('SIGKILL');
                reject(this.createError(`${command} timed out while processing the PDF.`, 504));
            }, options.timeoutMs || this.commandTimeoutMs);

            child.stdout.on('data', data => {
                stdout += data.toString();
            });

            child.stderr.on('data', data => {
                stderr += data.toString();
            });

            child.on('error', error => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeout);

                if (error.code === 'ENOENT') {
                    reject(this.createError(`Required PDF tool "${command}" is not installed in the backend container.`, 503));
                    return;
                }

                reject(error);
            });

            child.on('close', code => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeout);

                if (code === 0) {
                    resolve({ stdout, stderr });
                    return;
                }

                const detail = (stderr || stdout || '').trim();
                reject(this.createError(detail || `${command} failed with exit code ${code}.`, 422));
            });
        });
    }

    static async getOwnedFiles(userId, fileIds) {
        const uniqueFileIds = Array.from(new Set((fileIds || []).filter(Boolean).map(String)));

        if (!uniqueFileIds.length) {
            throw this.createError('Select at least one file.');
        }

        const files = await File.find({
            _id: { $in: uniqueFileIds },
            userId: userId.toString(),
            deleted: false
        });

        if (files.length !== uniqueFileIds.length) {
            throw this.createError('One or more files were not found or are not owned by you.', 403);
        }

        const fileById = files.reduce((result, file) => {
            result[file._id.toString()] = file;
            return result;
        }, {});

        return uniqueFileIds.map(fileId => fileById[fileId]);
    }

    static async assertOwnerPasswordAccess(userId, files) {
        files.forEach(file => FileService.assertPasswordAccess(file, userId));
    }

    static async createWorkRoot(userId) {
        const root = FileService.getTempPath('pdf-studio', userId.toString());
        await fs.ensureDir(root);
        return fs.mkdtemp(path.join(root, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-`));
    }

    static async materializeFiles(files, workRoot) {
        const inputDir = path.join(workRoot, 'input');
        await fs.ensureDir(inputDir);

        const usedNames = new Set();
        const materialized = [];

        for (const file of files) {
            let safeName = this.sanitizeFilename(file.name || `${file._id}`);
            const originalExtension = path.extname(safeName);
            const originalBase = path.basename(safeName, originalExtension);
            let counter = 1;

            while (usedNames.has(safeName.toLowerCase())) {
                safeName = `${originalBase}-${counter}${originalExtension}`;
                counter += 1;
            }

            usedNames.add(safeName.toLowerCase());

            const destinationPath = path.join(inputDir, safeName);
            const sourcePath = await StorageService.materializeFile(file, destinationPath);

            if (sourcePath !== destinationPath) {
                await fs.copy(sourcePath, destinationPath);
            }

            materialized.push({
                file,
                sourcePath: destinationPath,
                safeName
            });
        }

        return materialized;
    }

    static async getOutputTarget(userId, parentId, fallbackParentId = null) {
        const targetParentId = parentId === undefined ? fallbackParentId : parentId;
        const normalizedParentId = targetParentId || null;
        const relativeUploadDir = await FileService.getRelativeUploadDir(userId, normalizedParentId);

        return {
            parentId: normalizedParentId,
            relativeUploadDir
        };
    }

    static async saveGeneratedFile(outputPath, userId, target, filename, mimeOverride = null) {
        if (!await fs.pathExists(outputPath)) {
            throw this.createError('PDF Studio did not create an output file.', 500);
        }

        const safeName = this.sanitizeFilename(filename || path.basename(outputPath));
        let persistedPath = outputPath;

        if (!StorageService.isObjectStorage()) {
            persistedPath = path.join(FileService.uploadDirectory, target.relativeUploadDir, safeName);
            await fs.ensureDir(path.dirname(persistedPath));

            if (path.resolve(outputPath) !== path.resolve(persistedPath)) {
                await fs.copy(outputPath, persistedPath);
            }
        }

        const file = await FileService.saveFileMetadata(
            persistedPath,
            userId,
            safeName,
            target.parentId,
            target.relativeUploadDir
        );

        if (mimeOverride) {
            file.mimetype = mimeOverride;
            await file.save();
        }

        await FileService.recalculateFolderStats(target.parentId);

        return this.serializeGeneratedFile(file);
    }

    static serializeGeneratedFile(file) {
        return {
            id: file._id.toString(),
            name: file.name,
            path: file.path,
            mimetype: file.mimetype,
            size: file.size,
            scanStatus: file.scanStatus
        };
    }

    static async execute(userId, payload = {}) {
        const operation = String(payload.operation || '').trim();
        const options = payload.options || {};

        if (!this.supportedOperations.includes(operation)) {
            throw this.createError('Unsupported PDF Studio operation.');
        }

        const files = await this.getOwnedFiles(userId, payload.fileIds);
        await this.assertOwnerPasswordAccess(userId, files);

        const workRoot = await this.createWorkRoot(userId);

        try {
            const materializedFiles = await this.materializeFiles(files, workRoot);
            const target = await this.getOutputTarget(userId, payload.parentId, files[0] ? files[0].parent_id : null);

            switch (operation) {
                case 'merge':
                    return await this.merge(userId, materializedFiles, target, payload.outputFileName);
                case 'split':
                    return await this.split(userId, materializedFiles, target, options);
                case 'extract':
                    return await this.extract(userId, materializedFiles, target, payload.outputFileName, options);
                case 'reorder':
                    return await this.reorder(userId, materializedFiles, target, payload.outputFileName, options);
                case 'rotate':
                    return await this.rotate(userId, materializedFiles, target, payload.outputFileName, options);
                case 'compress':
                    return await this.compress(userId, materializedFiles, target, payload.outputFileName, options);
                case 'watermark':
                    return await this.watermark(userId, materializedFiles, target, payload.outputFileName, options);
                case 'protect':
                    return await this.protect(userId, materializedFiles, target, payload.outputFileName, options);
                case 'decorate':
                    return await this.decorate(userId, materializedFiles, target, payload.outputFileName, options, workRoot);
                case 'convert':
                    return await this.convert(userId, materializedFiles, target, payload.outputFileName, options, workRoot);
                case 'create':
                    return await this.createPdf(userId, materializedFiles, target, payload.outputFileName, options, workRoot);
                default:
                    throw this.createError('Unsupported PDF Studio operation.');
            }
        } finally {
            await fs.remove(workRoot);
        }
    }

    static requirePdfFiles(materializedFiles, count = null) {
        const pdfFiles = materializedFiles.filter(entry => this.isPdf(entry.file));

        if (count !== null && pdfFiles.length !== count) {
            throw this.createError(count === 1 ? 'Select exactly one PDF file.' : `Select exactly ${count} PDF files.`);
        }

        if (pdfFiles.length !== materializedFiles.length) {
            throw this.createError('This operation only supports PDF files.');
        }

        return pdfFiles;
    }

    static async merge(userId, materializedFiles, target, outputFileName) {
        this.requirePdfFiles(materializedFiles);

        if (materializedFiles.length < 2) {
            throw this.createError('Select at least two PDF files to merge.');
        }

        const outputName = this.ensureExtension(outputFileName || this.outputName('merged', 'pdf', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(materializedFiles[0].sourcePath), outputName);

        await this.runCommand('pdfcpu', [
            'merge',
            outputPath,
            ...materializedFiles.map(entry => entry.sourcePath)
        ]);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('PDFs merged successfully.', [file]);
    }

    static async split(userId, materializedFiles, target, options) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const outputDir = path.join(path.dirname(source.sourcePath), 'split-output');
        await fs.ensureDir(outputDir);

        const mode = ['span', 'page', 'bookmark'].includes(options.splitMode) ? options.splitMode : 'span';
        const args = ['split'];

        if (mode !== 'span') {
            args.push('-mode', mode);
        }

        args.push(source.sourcePath, outputDir);

        if (mode === 'span') {
            const span = parseInt(options.span || '1', 10);
            if (!Number.isInteger(span) || span < 1) {
                throw this.createError('Split span must be a positive number.');
            }
            args.push(String(span));
        }

        if (mode === 'page') {
            const splitBeforePages = String(options.splitBeforePages || '')
                .split(',')
                .map(page => page.trim())
                .filter(Boolean);

            if (!splitBeforePages.length) {
                throw this.createError('Provide the page numbers where the PDF should split before.');
            }

            args.push(...splitBeforePages);
        }

        await this.runCommand('pdfcpu', args);

        const outputFiles = (await fs.readdir(outputDir))
            .filter(filename => path.extname(filename).toLowerCase() === '.pdf')
            .sort();

        if (!outputFiles.length) {
            throw this.createError('Split completed but no PDF files were generated.', 500);
        }

        const savedFiles = [];
        for (let index = 0; index < outputFiles.length; index += 1) {
            const generatedPath = path.join(outputDir, outputFiles[index]);
            const baseName = path.basename(source.file.name, path.extname(source.file.name));
            const outputName = this.ensureExtension(`${baseName}-split-${index + 1}.pdf`, '.pdf');
            savedFiles.push(await this.saveGeneratedFile(generatedPath, userId, target, outputName, 'application/pdf'));
        }

        return this.result(`${savedFiles.length} split PDF file${savedFiles.length === 1 ? '' : 's'} created.`, savedFiles);
    }

    static async extract(userId, materializedFiles, target, outputFileName, options) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const pages = this.requirePages(options.pages, 'Selected pages');
        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'extracted', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);

        await this.runCommand('pdfcpu', ['trim', '-pages', pages, source.sourcePath, outputPath]);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('Selected pages extracted successfully.', [file]);
    }

    static async reorder(userId, materializedFiles, target, outputFileName, options) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const pages = this.requirePages(options.pageOrder, 'Page order');
        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'reordered', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);

        await this.runCommand('pdfcpu', ['collect', '-pages', pages, source.sourcePath, outputPath]);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('PDF pages reordered successfully.', [file]);
    }

    static async rotate(userId, materializedFiles, target, outputFileName, options) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const rotation = parseInt(options.rotation || '90', 10);

        if (![-270, -180, -90, 90, 180, 270].includes(rotation)) {
            throw this.createError('Rotation must be -270, -180, -90, 90, 180, or 270 degrees.');
        }

        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'rotated', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);
        const args = ['rotate'];
        const pages = this.normalizePageSelection(options.pages);

        if (pages) {
            args.push('-pages', pages);
        }

        args.push(source.sourcePath, String(rotation), outputPath);
        await this.runCommand('pdfcpu', args);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('PDF pages rotated successfully.', [file]);
    }

    static async compress(userId, materializedFiles, target, outputFileName, options) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'compressed', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);
        const profile = String(options.compressionProfile || 'optimize');

        if (profile === 'optimize') {
            await this.runCommand('pdfcpu', ['optimize', source.sourcePath, outputPath]);
        } else {
            const allowedProfiles = ['screen', 'ebook', 'printer', 'prepress', 'default'];
            if (!allowedProfiles.includes(profile)) {
                throw this.createError('Invalid compression profile.');
            }

            await this.runCommand('gs', [
                '-sDEVICE=pdfwrite',
                '-dCompatibilityLevel=1.4',
                `-dPDFSETTINGS=/${profile}`,
                '-dNOPAUSE',
                '-dQUIET',
                '-dBATCH',
                `-sOutputFile=${outputPath}`,
                source.sourcePath
            ]);
        }

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('PDF compressed successfully.', [file]);
    }

    static buildStampDescription(options = {}, defaults = {}) {
        const pick = function(...values) {
            for (const value of values) {
                if (value !== undefined && value !== null && value !== '') {
                    return value;
                }
            }

            return undefined;
        };

        const position = String(pick(options.position, defaults.position, 'c'));
        const fontSize = parseInt(pick(options.fontSize, defaults.fontSize, 36), 10);
        const opacity = Math.max(0.05, Math.min(1, parseFloat(pick(options.opacity, defaults.opacity, 0.35))));
        const rotation = parseInt(pick(options.textRotation, options.rotation, defaults.rotation, 0), 10);
        const offset = pick(options.offset, defaults.offset, '0 0');
        const scale = pick(options.scale, defaults.scale, '1 abs');
        const color = pick(options.color, defaults.color, '#555555');

        return `points:${fontSize}, pos:${position}, off:${offset}, rot:${rotation}, scale:${scale}, op:${opacity}, fillc:${color}`;
    }

    static async watermark(userId, materializedFiles, target, outputFileName, options) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const watermarkText = String(options.watermarkText || '').trim();

        if (!watermarkText) {
            throw this.createError('Watermark text is required.');
        }

        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'watermarked', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);
        const command = options.overlay === true ? 'stamp' : 'watermark';
        const args = [command, 'add'];
        const pages = this.normalizePageSelection(options.pages);

        if (pages) {
            args.push('-pages', pages);
        }

        args.push(
            '-mode',
            'text',
            '--',
            watermarkText,
            this.buildStampDescription(options, {
                position: 'c',
                rotation: 35,
                fontSize: 48,
                opacity: 0.25
            }),
            source.sourcePath,
            outputPath
        );

        await this.runCommand('pdfcpu', args);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('Watermark added successfully.', [file]);
    }

    static async protect(userId, materializedFiles, target, outputFileName, options) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const userPassword = String(options.userPassword || '').trim();
        const ownerPassword = String(options.ownerPassword || '').trim();

        if (!userPassword || !ownerPassword) {
            throw this.createError('User and owner passwords are required.');
        }

        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'protected', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);
        const permissions = options.allowFullAccess ? 'all' : 'none';

        await this.runCommand('pdfcpu', [
            'encrypt',
            '-mode',
            'aes',
            '-key',
            '256',
            '-perm',
            permissions,
            '-upw',
            userPassword,
            '-opw',
            ownerPassword,
            source.sourcePath,
            outputPath
        ]);

        await this.assertPdfRequiresPassword(outputPath);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('Password protected PDF created successfully.', [file]);
    }

    static async assertPdfRequiresPassword(pdfPath) {
        const result = await this.runCommand('qpdf', ['--show-encryption', pdfPath]);
        const output = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();

        if (output.includes('file is not encrypted') || !output.includes('encryption')) {
            throw this.createError('PDF Studio created the file, but encryption was not applied.', 500);
        }
    }

    static async decorate(userId, materializedFiles, target, outputFileName, options, workRoot) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const stamps = [];

        if (String(options.headerText || '').trim()) {
            stamps.push({
                text: String(options.headerText).trim(),
                description: this.buildStampDescription({}, {
                    position: 'tc',
                    offset: '0 -18',
                    rotation: 0,
                    fontSize: options.fontSize || 10,
                    opacity: 1,
                    color: '#222222'
                })
            });
        }

        if (String(options.footerText || '').trim()) {
            stamps.push({
                text: String(options.footerText).trim(),
                description: this.buildStampDescription({}, {
                    position: options.includePageNumbers ? 'bl' : 'bc',
                    offset: options.includePageNumbers ? '28 18' : '0 18',
                    rotation: 0,
                    fontSize: options.fontSize || 10,
                    opacity: 1,
                    color: '#222222'
                })
            });
        }

        if (options.includePageNumbers) {
            stamps.push({
                text: String(options.pageNumberText || 'Page %p of %P'),
                description: this.buildStampDescription({}, {
                    position: String(options.footerText || '').trim() ? 'br' : 'bc',
                    offset: String(options.footerText || '').trim() ? '-28 18' : '0 18',
                    rotation: 0,
                    fontSize: options.fontSize || 10,
                    opacity: 1,
                    color: '#222222'
                })
            });
        }

        if (!stamps.length) {
            throw this.createError('Add a header, footer, or page number option.');
        }

        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'decorated', '.pdf'), '.pdf');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);
        const pages = this.normalizePageSelection(options.pages);
        let currentInput = source.sourcePath;

        for (let index = 0; index < stamps.length; index += 1) {
            const stamp = stamps[index];
            const nextOutput = index === stamps.length - 1
                ? outputPath
                : path.join(workRoot, `decorate-${index}.pdf`);
            const args = ['stamp', 'add'];

            if (pages) {
                args.push('-pages', pages);
            }

            args.push('-mode', 'text', '--', stamp.text, stamp.description, currentInput, nextOutput);
            await this.runCommand('pdfcpu', args);
            currentInput = nextOutput;
        }

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('Header, footer, and page numbers applied successfully.', [file]);
    }

    static async convert(userId, materializedFiles, target, outputFileName, options, workRoot) {
        const [source] = this.requirePdfFiles(materializedFiles, 1);
        const targetFormat = String(options.targetFormat || '').toLowerCase();

        switch (targetFormat) {
            case 'images':
                return await this.convertPdfToImages(userId, source, target, options, workRoot);
            case 'text':
                return await this.convertPdfToText(userId, source, target, outputFileName, options);
            case 'html':
                return await this.convertPdfToHtml(userId, source, target, outputFileName, options);
            case 'docx':
            case 'word':
                return await this.convertPdfToWord(userId, source, target, outputFileName, options);
            default:
                throw this.createError('Choose a conversion target: images, text, Word, or HTML.');
        }
    }

    static async convertPdfToImages(userId, source, target, options, workRoot) {
        const outputDir = path.join(workRoot, 'pdf-images');
        await fs.ensureDir(outputDir);

        const format = ['png', 'jpeg'].includes(options.imageFormat) ? options.imageFormat : 'png';
        const extension = format === 'jpeg' ? '.jpg' : '.png';
        const prefix = path.join(outputDir, path.basename(source.file.name, path.extname(source.file.name)));
        const dpi = parseInt(options.dpi || '150', 10);
        const args = [`-${format}`, '-r', String(Number.isInteger(dpi) && dpi > 0 ? dpi : 150)];

        if (options.firstPage) {
            args.push('-f', String(parseInt(options.firstPage, 10)));
        }

        if (options.lastPage) {
            args.push('-l', String(parseInt(options.lastPage, 10)));
        }

        args.push(source.sourcePath, prefix);

        await this.runCommand('pdftoppm', args);

        const outputFiles = (await fs.readdir(outputDir))
            .filter(filename => path.extname(filename).toLowerCase() === extension)
            .sort();

        if (!outputFiles.length) {
            throw this.createError('PDF image conversion did not create any image files.', 500);
        }

        const savedFiles = [];
        const baseName = path.basename(source.file.name, path.extname(source.file.name));

        for (let index = 0; index < outputFiles.length; index += 1) {
            const generatedPath = path.join(outputDir, outputFiles[index]);
            const outputName = this.ensureExtension(`${baseName}-page-${index + 1}${extension}`, extension);
            savedFiles.push(await this.saveGeneratedFile(generatedPath, userId, target, outputName, mime.getType(outputName)));
        }

        return this.result(`${savedFiles.length} page image${savedFiles.length === 1 ? '' : 's'} created.`, savedFiles);
    }

    static async convertPdfToText(userId, source, target, outputFileName, options) {
        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'text', '.txt'), '.txt');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);
        const args = [];

        if (options.preserveLayout !== false) {
            args.push('-layout');
        }

        args.push(source.sourcePath, outputPath);
        await this.runCommand('pdftotext', args);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'text/plain');
        return this.result('PDF converted to text successfully.', [file]);
    }

    static async convertPdfToHtml(userId, source, target, outputFileName, options) {
        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'html', '.html'), '.html');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);
        const args = ['-s'];

        if (options.ignoreImages) {
            args.push('-i');
        }

        args.push(source.sourcePath, outputPath);
        await this.runCommand('pdftohtml', args);

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'text/html');
        return this.result('PDF converted to HTML successfully.', [file]);
    }

    static async convertPdfToWord(userId, source, target, outputFileName, options) {
        const outputName = this.ensureExtension(outputFileName || this.outputName(source.file.name, 'word', '.docx'), '.docx');
        const outputPath = path.join(path.dirname(source.sourcePath), outputName);

        await this.runCommand('pdf2docx', ['convert', source.sourcePath, '-d', outputPath]);

        const file = await this.saveGeneratedFile(
            outputPath,
            userId,
            target,
            outputName,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );

        return this.result('PDF converted to Word successfully.', [file]);
    }

    static async createPdf(userId, materializedFiles, target, outputFileName, options, workRoot) {
        if (!materializedFiles.length) {
            throw this.createError('Select files to create a PDF.');
        }

        const outputName = this.ensureExtension(outputFileName || `created-pdf-${Date.now()}.pdf`, '.pdf');
        const outputPath = path.join(workRoot, outputName);
        const allImages = materializedFiles.every(entry => this.isImage(entry.file));

        if (allImages) {
            const imagePaths = [];

            for (let index = 0; index < materializedFiles.length; index += 1) {
                imagePaths.push(await this.prepareImageForPdfImport(materializedFiles[index], workRoot, index));
            }

            await this.runCommand('pdfcpu', [
                'import',
                outputPath,
                ...imagePaths
            ]);
        } else {
            const temporaryPdfs = [];

            for (let index = 0; index < materializedFiles.length; index += 1) {
                const entry = materializedFiles[index];
                const tempPdfPath = path.join(workRoot, `create-source-${index + 1}.pdf`);

                if (this.isPdf(entry.file)) {
                    temporaryPdfs.push(entry.sourcePath);
                    continue;
                }

                if (this.isImage(entry.file)) {
                    const imagePath = await this.prepareImageForPdfImport(entry, workRoot, index);
                    await this.runCommand('pdfcpu', ['import', tempPdfPath, imagePath]);
                    temporaryPdfs.push(tempPdfPath);
                    continue;
                }

                if (this.isTextLike(entry.file) || this.isOfficeDocument(entry.file)) {
                    const converted = await this.convertDocumentToPdf(entry.sourcePath, workRoot);
                    temporaryPdfs.push(converted);
                    continue;
                }

                throw this.createError(`Cannot create a PDF from "${entry.file.name}".`);
            }

            if (temporaryPdfs.length === 1) {
                await fs.copy(temporaryPdfs[0], outputPath);
            } else {
                await this.runCommand('pdfcpu', ['merge', outputPath, ...temporaryPdfs]);
            }
        }

        const file = await this.saveGeneratedFile(outputPath, userId, target, outputName, 'application/pdf');
        return this.result('PDF created successfully.', [file]);
    }

    static async convertDocumentToPdf(sourcePath, workRoot) {
        const outputDir = path.join(workRoot, 'document-pdfs');
        await fs.ensureDir(outputDir);

        const before = new Set(await fs.readdir(outputDir));

        await this.runCommand('soffice', [
            '--headless',
            '--nologo',
            '--nofirststartwizard',
            '--convert-to',
            'pdf',
            '--outdir',
            outputDir,
            sourcePath
        ], {
            home: path.join(workRoot, 'libreoffice-home'),
            timeoutMs: this.commandTimeoutMs
        });

        const after = await fs.readdir(outputDir);
        const created = after
            .filter(filename => !before.has(filename) && path.extname(filename).toLowerCase() === '.pdf')
            .sort();

        if (!created.length) {
            const fallbackName = `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`;
            const fallbackPath = path.join(outputDir, fallbackName);
            if (await fs.pathExists(fallbackPath)) {
                return fallbackPath;
            }

            throw this.createError(`LibreOffice could not convert "${path.basename(sourcePath)}" to PDF.`, 422);
        }

        return path.join(outputDir, created[0]);
    }

    static result(message, files) {
        return {
            success: true,
            message,
            files
        };
    }
}

module.exports = PdfStudioService;
