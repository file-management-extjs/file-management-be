const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ExcelJS = require('exceljs');
const PptxGenJS = require('pptxgenjs');
const mime = require('mime');
const {
    TARGET_FORMATS,
    getExtension,
    isPdf,
    isWordDocument,
    isSpreadsheetDocument,
    isPresentationDocument,
    isMarkdownDocument,
    isHtmlDocument,
    isPlainTextDocument
} = require('./documentFormats');

function createError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function sanitizeFilename(filename, fallback = 'converted-document') {
    const base = path.basename(String(filename || fallback)).trim();
    return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || fallback;
}

function ensureExtension(filename, extension) {
    const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`;
    const safeName = sanitizeFilename(filename, `converted-document${normalizedExtension}`);
    return safeName.toLowerCase().endsWith(normalizedExtension.toLowerCase())
        ? safeName
        : `${safeName}${normalizedExtension}`;
}

function stripExtension(filename) {
    const safeName = sanitizeFilename(filename, 'converted-document');
    return path.basename(safeName, path.extname(safeName));
}

function buildOutputName(sourceFile, targetFormat, requestedOutputName, index, total) {
    const sourceBaseName = stripExtension(sourceFile.name || `document-${index + 1}`);
    const targetInfo = TARGET_FORMATS[targetFormat];

    if (!targetInfo) {
        throw createError(`Unsupported document target "${targetFormat}".`);
    }

    let baseName = sourceBaseName;

    if (requestedOutputName) {
        const requestedBaseName = stripExtension(requestedOutputName);
        baseName = total > 1 ? `${requestedBaseName}-${sourceBaseName}` : requestedBaseName;
    } else if (targetFormat === 'webhtml') {
        baseName = `${sourceBaseName}-web-preview`;
    }

    return ensureExtension(baseName, targetInfo.extension);
}

function appendCommandOutput(currentOutput, chunk, limit = 128 * 1024) {
    const nextOutput = `${currentOutput}${chunk.toString()}`;

    if (nextOutput.length <= limit) {
        return nextOutput;
    }

    return nextOutput.slice(nextOutput.length - limit);
}

function registerChildProcess(options, child) {
    if (!options || !options.processTracker) {
        return;
    }

    options.processTracker.add(child);
}

function unregisterChildProcess(options, child) {
    if (options && options.processTracker) {
        options.processTracker.delete(child);
    }
}

function assertNotCancelled(options = {}) {
    if (typeof options.isCancelled === 'function' && options.isCancelled()) {
        const error = createError('Document conversion cancelled.', 499);
        error.cancelled = true;
        throw error;
    }
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toCsvCell(value) {
    const normalized = String(value == null ? '' : value);
    return `"${normalized.replace(/"/g, '""')}"`;
}

function imageMetadataToDocxPage(metadata, dpi, imagePath) {
    const width = Math.max(1, metadata.width || 1);
    const height = Math.max(1, metadata.height || 1);
    const normalizedDpi = Number.isFinite(dpi) && dpi > 0 ? dpi : 144;
    const widthInches = width / normalizedDpi;
    const heightInches = height / normalizedDpi;

    return {
        path: imagePath,
        widthEmu: Math.round(widthInches * 914400),
        heightEmu: Math.round(heightInches * 914400)
    };
}

function parsePdfTextPages(rawText) {
    return String(rawText || '')
        .split('\f')
        .map(pageText => pageText.replace(/\u0000/g, '').trimEnd())
        .filter(pageText => pageText.trim().length > 0);
}

function getConversionOption(options = {}, key, fallback = undefined) {
    if (options.options && Object.prototype.hasOwnProperty.call(options.options, key)) {
        return options.options[key];
    }

    if (Object.prototype.hasOwnProperty.call(options, key)) {
        return options[key];
    }

    return fallback;
}

function getPandocInputFormat(file, fallback = 'plain') {
    if (isMarkdownDocument(file)) {
        return 'markdown';
    }

    if (isHtmlDocument(file)) {
        return 'html';
    }

    if (isPlainTextDocument(file)) {
        return 'plain';
    }

    const extension = getExtension(file);

    if (extension === '.docx') {
        return 'docx';
    }

    if (extension === '.odt') {
        return 'odt';
    }

    if (extension === '.rtf') {
        return 'rtf';
    }

    return fallback;
}

function getPandocOutputFormat(targetFormat) {
    switch (targetFormat) {
        case 'txt':
            return 'plain';
        case 'md':
            return 'gfm';
        case 'rtf':
            return 'rtf';
        case 'docx':
            return 'docx';
        default:
            return targetFormat;
    }
}

function getLibreOfficeConvertSpec(targetFormat) {
    switch (targetFormat) {
        case 'pdf':
            return 'pdf';
        case 'docx':
            return 'docx:"MS Word 2007 XML"';
        case 'xlsx':
            return 'xlsx:"Calc MS Excel 2007 XML"';
        case 'pptx':
            return 'pptx:"Impress MS PowerPoint 2007 XML"';
        case 'txt':
            return 'txt:Text';
        case 'rtf':
            return 'rtf';
        case 'csv':
            return 'csv:Text - txt - csv (StarCalc)';
        default:
            return targetFormat;
    }
}

async function isPdfEncrypted(pdfPath, options = {}) {
    const result = await runCommand('qpdf', ['--show-encryption', pdfPath], options);
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();

    if (output.includes('file is not encrypted')) {
        return false;
    }

    return output.includes('incorrect password supplied') ||
        output.includes('file encryption method') ||
        output.includes('user password');
}

async function assertPdfConversionAccess(entry, options = {}) {
    const encrypted = await isPdfEncrypted(entry.sourcePath, options);

    if (encrypted) {
        throw createError(
            `The PDF "${entry.file.name}" is password protected. Remove the PDF password before converting it in Document Conversion Suite.`,
            422
        );
    }
}

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            assertNotCancelled(options);
        } catch (error) {
            reject(error);
            return;
        }

        const child = spawn(command, args, {
            cwd: options.cwd,
            env: {
                ...process.env,
                HOME: options.home || process.env.HOME || '/tmp'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        registerChildProcess(options, child);

        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            child.kill('SIGKILL');
            reject(createError(`${command} timed out while converting the document.`, 504));
        }, options.timeoutMs || 10 * 60 * 1000);

        child.stdout.on('data', data => {
            stdout = appendCommandOutput(stdout, data);
        });

        child.stderr.on('data', data => {
            stderr = appendCommandOutput(stderr, data);
        });

        child.on('error', error => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            unregisterChildProcess(options, child);

            if (error.code === 'ENOENT') {
                reject(createError(`Required document tool "${command}" is not installed in the backend container.`, 503));
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
            unregisterChildProcess(options, child);

            if (typeof options.isCancelled === 'function' && options.isCancelled()) {
                const error = createError('Document conversion cancelled.', 499);
                error.cancelled = true;
                reject(error);
                return;
            }

            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }

            reject(createError((stderr || stdout || '').trim() || `${command} failed with exit code ${code}.`, 422));
        });
    });
}

async function libreOfficeConvert(sourcePath, targetFormat, outputDir, options = {}) {
    await fs.ensureDir(outputDir);
    const before = new Set(await fs.readdir(outputDir));
    const convertSpec = getLibreOfficeConvertSpec(targetFormat);

    await runCommand('soffice', [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to',
        convertSpec,
        '--outdir',
        outputDir,
        sourcePath
    ], {
        ...options,
        home: path.join(outputDir, '.libreoffice-home')
    });

    const targetExtension = TARGET_FORMATS[targetFormat]
        ? TARGET_FORMATS[targetFormat].extension
        : `.${targetFormat}`;
    const after = await fs.readdir(outputDir);
    const created = after
        .filter(filename => !before.has(filename) && path.extname(filename).toLowerCase() === targetExtension)
        .sort();

    if (created.length > 0) {
        return path.join(outputDir, created[0]);
    }

    const fallback = path.join(outputDir, `${path.basename(sourcePath, path.extname(sourcePath))}${targetExtension}`);
    if (await fs.pathExists(fallback)) {
        return fallback;
    }

    throw createError(`LibreOffice could not create a ${targetFormat.toUpperCase()} output from "${path.basename(sourcePath)}".`, 422);
}

async function pandocConvert(sourcePath, sourceFormat, targetFormat, outputPath, options = {}) {
    await fs.ensureDir(path.dirname(outputPath));

    await runCommand('pandoc', [
        '--from',
        sourceFormat,
        '--to',
        getPandocOutputFormat(targetFormat),
        '--standalone',
        sourcePath,
        '-o',
        outputPath
    ], options);

    if (!await fs.pathExists(outputPath)) {
        throw createError(`Pandoc did not create the ${targetFormat.toUpperCase()} output.`, 500);
    }

    return outputPath;
}

async function renderPdfToImages(pdfPath, workRoot, options = {}) {
    const outputDir = path.join(workRoot, 'pdf-pages');
    const prefix = path.join(outputDir, 'page');
    const dpi = parseInt(getConversionOption(options, 'previewDpi', 144), 10);

    await fs.ensureDir(outputDir);

    await runCommand('pdftoppm', [
        '-png',
        '-r',
        String(Number.isInteger(dpi) && dpi > 0 ? dpi : 144),
        pdfPath,
        prefix
    ], options);

    const files = (await fs.readdir(outputDir))
        .filter(filename => path.extname(filename).toLowerCase() === '.png')
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    if (!files.length) {
        throw createError('No PDF page previews were generated.', 500);
    }

    return files.map(filename => path.join(outputDir, filename));
}

function getVisualDocxBuilderScript() {
    return `
import json
import os
import sys

from docx import Document
from docx.enum.section import WD_SECTION
from docx.shared import Emu, Pt


def apply_section_size(section, page):
    section.page_width = Emu(int(page["widthEmu"]))
    section.page_height = Emu(int(page["heightEmu"]))
    section.top_margin = Emu(0)
    section.right_margin = Emu(0)
    section.bottom_margin = Emu(0)
    section.left_margin = Emu(0)
    section.header_distance = Emu(0)
    section.footer_distance = Emu(0)


def add_page_image(document, page):
    paragraph = document.add_paragraph()
    paragraph.alignment = 0
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.paragraph_format.left_indent = Pt(0)
    paragraph.paragraph_format.right_indent = Pt(0)
    run = paragraph.add_run()
    run.add_picture(
        page["path"],
        width=Emu(int(page["widthEmu"])),
        height=Emu(int(page["heightEmu"]))
    )


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: build_visual_docx.py <manifest.json>")

    with open(sys.argv[1], "r", encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)

    pages = manifest.get("pages") or []
    output_path = manifest.get("outputPath")

    if not pages:
        raise SystemExit("No pages were provided for DOCX creation.")
    if not output_path:
        raise SystemExit("No output path was provided for DOCX creation.")

    document = Document()
    apply_section_size(document.sections[0], pages[0])

    for index, page in enumerate(pages):
        if not os.path.exists(page["path"]):
            raise SystemExit(f"Missing rendered page image: {page['path']}")

        if index > 0:
            apply_section_size(document.add_section(WD_SECTION.NEW_PAGE), page)

        add_page_image(document, page)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    document.save(output_path)

    # Re-open with python-docx so package-level corruption is caught immediately.
    Document(output_path)


if __name__ == "__main__":
    main()
`.trimStart();
}

async function validateDocxWithLibreOffice(docxPath, workRoot, options = {}) {
    const validationDir = path.join(workRoot, 'libreoffice');
    await fs.ensureDir(validationDir);

    await runCommand('soffice', [
        '--headless',
        '--nologo',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        validationDir,
        docxPath
    ], {
        ...options,
        home: path.join(validationDir, '.libreoffice-home')
    });

    const validationPdfPath = path.join(
        validationDir,
        `${path.basename(docxPath, path.extname(docxPath))}.pdf`
    );

    if (!await fs.pathExists(validationPdfPath)) {
        throw createError('The DOCX was created but LibreOffice could not validate it.', 500);
    }
}

async function createVisualDocxFromImages(imagePaths, outputPath, dpi, workRoot, options = {}) {
    if (!Array.isArray(imagePaths) || !imagePaths.length) {
        throw createError('No PDF page images were available for DOCX creation.', 500);
    }

    await fs.ensureDir(path.dirname(outputPath));

    const pages = [];

    for (let index = 0; index < imagePaths.length; index += 1) {
        const imagePath = imagePaths[index];
        const metadata = await sharp(imagePath).metadata();
        pages.push(imageMetadataToDocxPage(metadata, dpi, imagePath));
    }

    const builderDir = path.join(workRoot, 'visual-docx-builder');
    const builderPath = path.join(builderDir, 'build_visual_docx.py');
    const manifestPath = path.join(builderDir, 'manifest.json');

    await fs.ensureDir(builderDir);
    await fs.writeFile(builderPath, getVisualDocxBuilderScript(), 'utf8');
    await fs.writeJson(manifestPath, {
        outputPath,
        pages
    });

    await runCommand('python3', [builderPath, manifestPath], {
        ...options,
        cwd: builderDir
    });

    if (!await fs.pathExists(outputPath)) {
        throw createError('Visual PDF to DOCX conversion did not create an output file.', 500);
    }

    await validateDocxWithLibreOffice(outputPath, path.join(workRoot, 'visual-docx-validation'), options);

    return outputPath;
}

async function convertPdfToVisualDocx(entry, outputPath, workRoot, options = {}) {
    const dpi = parseInt(getConversionOption(options, 'previewDpi', 144), 10);
    const normalizedDpi = Number.isInteger(dpi) && dpi > 0 ? dpi : 144;
    const imagePaths = await renderPdfToImages(entry.sourcePath, path.join(workRoot, 'docx-visual-pages'), {
        ...options,
        previewDpi: normalizedDpi
    });

    return createVisualDocxFromImages(imagePaths, outputPath, normalizedDpi, workRoot, options);
}

async function extractPdfText(pdfPath, outputPath, options = {}) {
    await fs.ensureDir(path.dirname(outputPath));

    await runCommand('pdftotext', [
        '-layout',
        pdfPath,
        outputPath
    ], options);

    if (!await fs.pathExists(outputPath)) {
        throw createError('PDF text extraction did not create a text file.', 500);
    }

    return outputPath;
}

async function convertSourceToPdf(entry, workRoot, options = {}) {
    if (isPdf(entry.file)) {
        return entry.sourcePath;
    }

    const outputDir = path.join(workRoot, 'pdf-output');
    await fs.ensureDir(outputDir);

    if (isMarkdownDocument(entry.file)) {
        const bridgeDocx = path.join(workRoot, `${stripExtension(entry.file.name)}-bridge.docx`);
        await pandocConvert(entry.sourcePath, 'markdown', 'docx', bridgeDocx, options);
        return libreOfficeConvert(bridgeDocx, 'pdf', outputDir, options);
    }

    return libreOfficeConvert(entry.sourcePath, 'pdf', outputDir, options);
}

async function normalizeWordSourceToDocx(entry, workRoot, options = {}) {
    if (getExtension(entry.file) === '.docx') {
        return entry.sourcePath;
    }

    return libreOfficeConvert(entry.sourcePath, 'docx', path.join(workRoot, 'normalized-word'), options);
}

async function convertPdfToEditableDocx(entry, outputPath, options = {}) {
    await fs.ensureDir(path.dirname(outputPath));

    const result = await runCommand('pdf2docx', [
        'convert',
        entry.sourcePath,
        '-d',
        outputPath,
        '--raw_exceptions=true'
    ], options);

    if (await fs.pathExists(outputPath)) {
        return outputPath;
    }

    // Some pdf2docx builds ignore the requested output path and write beside the source PDF.
    const sourceSideOutputPath = path.join(
        path.dirname(entry.sourcePath),
        `${path.basename(entry.sourcePath, path.extname(entry.sourcePath))}.docx`
    );

    if (await fs.pathExists(sourceSideOutputPath)) {
        if (path.resolve(sourceSideOutputPath) !== path.resolve(outputPath)) {
            await fs.move(sourceSideOutputPath, outputPath, { overwrite: true });
        }

        return outputPath;
    }

    const commandOutput = [result.stderr, result.stdout]
        .filter(Boolean)
        .join('\n')
        .trim();

    throw createError(
        commandOutput
            ? `PDF to DOCX conversion did not create an output file. Converter output: ${commandOutput}`
            : 'PDF to DOCX conversion did not create an output file.',
        500
    );
}

async function convertPdfToDocx(entry, outputPath, workRoot, options = {}) {
    if (getConversionOption(options, 'preserveLayout', true) !== false) {
        return convertPdfToVisualDocx(entry, outputPath, workRoot, options);
    }

    return convertPdfToEditableDocx(entry, outputPath, options);
}

async function convertPdfToCsv(entry, outputPath, options = {}) {
    const tempTextPath = path.join(path.dirname(outputPath), `${stripExtension(path.basename(outputPath))}.txt`);
    await extractPdfText(entry.sourcePath, tempTextPath, options);
    const rawText = await fs.readFile(tempTextPath, 'utf8');
    const pages = parsePdfTextPages(rawText);
    const rows = ['page,line,text'];

    pages.forEach((pageText, pageIndex) => {
        pageText.split(/\r?\n/).forEach((lineText, lineIndex) => {
            if (!lineText.trim()) {
                return;
            }

            rows.push([
                pageIndex + 1,
                lineIndex + 1,
                toCsvCell(lineText)
            ].join(','));
        });
    });

    await fs.writeFile(outputPath, rows.join('\n'), 'utf8');
    return outputPath;
}

async function convertPdfToMarkdown(entry, outputPath, options = {}) {
    const tempTextPath = path.join(path.dirname(outputPath), `${stripExtension(path.basename(outputPath))}.txt`);
    await extractPdfText(entry.sourcePath, tempTextPath, options);
    return pandocConvert(tempTextPath, 'plain', 'md', outputPath, options);
}

async function convertPdfToRtf(entry, outputPath, options = {}) {
    const tempTextPath = path.join(path.dirname(outputPath), `${stripExtension(path.basename(outputPath))}.txt`);
    await extractPdfText(entry.sourcePath, tempTextPath, options);
    return pandocConvert(tempTextPath, 'plain', 'rtf', outputPath, options);
}

async function buildPreviewHtml(sourceName, imagePaths, outputPath) {
    const sections = await Promise.all(imagePaths.map(async (imagePath, index) => {
        const base64 = await fs.readFile(imagePath, 'base64');
        const imageMime = mime.getType(imagePath) || 'image/png';
        return `
            <section class="doc-page">
                <div class="page-label">Page ${index + 1}</div>
                <img src="data:${imageMime};base64,${base64}" alt="Page ${index + 1}" />
            </section>
        `;
    }));

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(sourceName)}</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #eaf2fb;
            --panel: #ffffff;
            --ink: #15314c;
            --muted: #5f7792;
            --border: #b7cdeb;
        }

        * { box-sizing: border-box; }

        body {
            margin: 0;
            min-height: 100vh;
            font-family: Tahoma, Arial, sans-serif;
            background: linear-gradient(180deg, #eef5fd 0%, var(--bg) 100%);
            color: var(--ink);
        }

        .shell {
            max-width: 1200px;
            margin: 0 auto;
            padding: 24px 20px 40px;
        }

        .hero {
            margin-bottom: 16px;
            padding: 18px 22px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--panel);
            box-shadow: 0 12px 32px rgba(54, 88, 128, 0.08);
        }

        .eyebrow {
            display: inline-block;
            margin-bottom: 6px;
            color: #2f5f90;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.12em;
            text-transform: uppercase;
        }

        h1 {
            margin: 0;
            font-size: clamp(24px, 4vw, 38px);
            line-height: 1.15;
        }

        .subtitle {
            margin-top: 8px;
            color: var(--muted);
            font-size: 14px;
        }

        .doc-page {
            margin: 0 auto 18px;
            padding: 10px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.88);
            box-shadow: 0 16px 28px rgba(66, 100, 136, 0.08);
        }

        .page-label {
            margin-bottom: 8px;
            color: var(--muted);
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .doc-page img {
            display: block;
            width: 100%;
            height: auto;
            border-radius: 8px;
        }
    </style>
</head>
<body>
    <main class="shell">
        <header class="hero">
            <div class="eyebrow">Document Preview</div>
            <h1>${escapeHtml(sourceName)}</h1>
            <div class="subtitle">This self-contained HTML preview preserves the original page layout for browser viewing.</div>
        </header>
        ${sections.join('\n')}
    </main>
</body>
</html>`;

    await fs.writeFile(outputPath, html, 'utf8');
    return outputPath;
}

async function convertAnyToWebHtml(entry, outputPath, workRoot, options = {}) {
    const pdfPath = await convertSourceToPdf(entry, path.join(workRoot, 'web-preview'), options);
    const pageImages = await renderPdfToImages(pdfPath, path.join(workRoot, 'web-preview-images'), options);
    await buildPreviewHtml(entry.file.name, pageImages, outputPath);
    return outputPath;
}

async function convertPdfToPptx(entry, outputPath, workRoot, options = {}) {
    const pageImages = await renderPdfToImages(entry.sourcePath, path.join(workRoot, 'pptx-pages'), options);
    const firstImageMetadata = await sharp(pageImages[0]).metadata();
    const imageWidth = firstImageMetadata.width || 1200;
    const imageHeight = firstImageMetadata.height || 1600;
    const slideWidth = 10;
    const slideHeight = Number((slideWidth * imageHeight / imageWidth).toFixed(3));
    const pptx = new PptxGenJS();

    pptx.defineLayout({
        name: 'DOC_PAGE',
        width: slideWidth,
        height: slideHeight
    });
    pptx.layout = 'DOC_PAGE';
    pptx.author = 'File Management';
    pptx.subject = 'PDF to PPTX conversion';
    pptx.title = entry.file.name;
    pptx.company = 'File Management';
    pptx.lang = 'en-US';

    pageImages.forEach((imagePath, index) => {
        const slide = pptx.addSlide();
        slide.background = { color: 'F4F7FB' };
        slide.addImage({
            path: imagePath,
            x: 0,
            y: 0,
            w: slideWidth,
            h: slideHeight
        });
        slide.addText(`Page ${index + 1}`, {
            x: 0.2,
            y: 0.1,
            w: 1.2,
            h: 0.3,
            fontSize: 9,
            color: '5B7592',
            bold: true
        });
    });

    await pptx.writeFile({ fileName: outputPath });
    return outputPath;
}

async function convertPdfToXlsx(entry, outputPath, workRoot, options = {}) {
    const pageImages = await renderPdfToImages(entry.sourcePath, path.join(workRoot, 'xlsx-pages'), options);
    const tempTextPath = path.join(workRoot, 'pdf-text', `${stripExtension(entry.file.name)}.txt`);
    await extractPdfText(entry.sourcePath, tempTextPath, options);
    const rawText = await fs.readFile(tempTextPath, 'utf8');
    const pages = parsePdfTextPages(rawText);
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'File Management';
    workbook.lastModifiedBy = 'File Management';
    workbook.created = new Date();
    workbook.modified = new Date();

    for (let index = 0; index < pageImages.length; index += 1) {
        const imagePath = pageImages[index];
        const metadata = await sharp(imagePath).metadata();
        const worksheet = workbook.addWorksheet(`Page ${index + 1}`);
        const imageId = workbook.addImage({
            filename: imagePath,
            extension: 'png'
        });

        worksheet.views = [{ showGridLines: false }];
        worksheet.getColumn(1).width = Math.max(20, Math.min(160, Math.round((metadata.width || 1200) / 10)));
        worksheet.getRow(1).height = Math.max(24, Math.round((metadata.height || 1600) * 0.75));
        worksheet.getCell('A1').value = `Page ${index + 1}`;
        worksheet.getCell('A1').font = {
            bold: true,
            color: { argb: '305D90' }
        };

        worksheet.addImage(imageId, {
            tl: { col: 0, row: 1.2 },
            ext: {
                width: metadata.width || 1200,
                height: metadata.height || 1600
            }
        });
    }

    const textSheet = workbook.addWorksheet('Extracted Text');
    textSheet.columns = [
        { header: 'Page', key: 'page', width: 10 },
        { header: 'Line', key: 'line', width: 10 },
        { header: 'Text', key: 'text', width: 120 }
    ];

    pages.forEach((pageText, pageIndex) => {
        pageText.split(/\r?\n/).forEach((lineText, lineIndex) => {
            if (!lineText.trim()) {
                return;
            }

            textSheet.addRow({
                page: pageIndex + 1,
                line: lineIndex + 1,
                text: lineText
            });
        });
    });

    await workbook.xlsx.writeFile(outputPath);
    return outputPath;
}

async function convertWordLike(entry, targetFormat, outputPath, workRoot, options = {}) {
    const docxSourcePath = await normalizeWordSourceToDocx(entry, path.join(workRoot, 'word-source'), options);

    if (targetFormat === 'docx') {
        await fs.copy(docxSourcePath, outputPath);
        return outputPath;
    }

    return pandocConvert(docxSourcePath, 'docx', targetFormat, outputPath, options);
}

async function convertTextLike(entry, targetFormat, outputPath, options = {}) {
    const sourceFormat = getPandocInputFormat(entry.file);
    return pandocConvert(entry.sourcePath, sourceFormat, targetFormat, outputPath, options);
}

async function convertSpreadsheetLike(entry, targetFormat, outputPath, workRoot, options = {}) {
    const convertedPath = await libreOfficeConvert(entry.sourcePath, targetFormat, path.join(workRoot, 'sheet-output'), options);
    await fs.copy(convertedPath, outputPath);
    return outputPath;
}

async function convertPresentationLike(entry, targetFormat, outputPath, workRoot, options = {}) {
    const convertedPath = await libreOfficeConvert(entry.sourcePath, targetFormat, path.join(workRoot, 'slides-output'), options);
    await fs.copy(convertedPath, outputPath);
    return outputPath;
}

async function convertPdfTarget(entry, targetFormat, outputPath, workRoot, options = {}) {
    await assertPdfConversionAccess(entry, options);

    switch (targetFormat) {
        case 'docx':
            return convertPdfToDocx(entry, outputPath, workRoot, options);
        case 'xlsx':
            return convertPdfToXlsx(entry, outputPath, workRoot, options);
        case 'pptx':
            return convertPdfToPptx(entry, outputPath, workRoot, options);
        case 'txt':
            return extractPdfText(entry.sourcePath, outputPath, options);
        case 'csv':
            return convertPdfToCsv(entry, outputPath, options);
        case 'md':
            return convertPdfToMarkdown(entry, outputPath, options);
        case 'rtf':
            return convertPdfToRtf(entry, outputPath, options);
        case 'webhtml':
            return convertAnyToWebHtml(entry, outputPath, workRoot, options);
        default:
            throw createError(`PDF conversion to ${targetFormat.toUpperCase()} is not supported.`);
    }
}

async function convertEntryToTarget(entry, targetFormat, context = {}) {
    const outputName = buildOutputName(
        entry.file,
        targetFormat,
        context.requestedOutputName,
        context.index || 0,
        context.total || 1
    );
    const outputPath = path.join(context.outputDir, outputName);

    await fs.ensureDir(context.outputDir);
    assertNotCancelled(context);

    if (targetFormat === 'pdf') {
        const pdfPath = await convertSourceToPdf(entry, path.join(context.workRoot, 'pdf'), context);
        if (pdfPath === entry.sourcePath) {
            await fs.copy(entry.sourcePath, outputPath);
        } else {
            await fs.copy(pdfPath, outputPath);
        }

        return {
            path: outputPath,
            fileName: outputName,
            mimeType: TARGET_FORMATS.pdf.mimeType
        };
    }

    if (isPdf(entry.file)) {
        await convertPdfTarget(entry, targetFormat, outputPath, context.workRoot, context);
        return {
            path: outputPath,
            fileName: outputName,
            mimeType: TARGET_FORMATS[targetFormat].mimeType
        };
    }

    if (targetFormat === 'webhtml') {
        await convertAnyToWebHtml(entry, outputPath, context.workRoot, context);
        return {
            path: outputPath,
            fileName: outputName,
            mimeType: TARGET_FORMATS.webhtml.mimeType
        };
    }

    if (isWordDocument(entry.file)) {
        await convertWordLike(entry, targetFormat, outputPath, context.workRoot, context);
        return {
            path: outputPath,
            fileName: outputName,
            mimeType: TARGET_FORMATS[targetFormat].mimeType
        };
    }

    if (isSpreadsheetDocument(entry.file)) {
        await convertSpreadsheetLike(entry, targetFormat, outputPath, context.workRoot, context);
        return {
            path: outputPath,
            fileName: outputName,
            mimeType: TARGET_FORMATS[targetFormat].mimeType
        };
    }

    if (isPresentationDocument(entry.file)) {
        await convertPresentationLike(entry, targetFormat, outputPath, context.workRoot, context);
        return {
            path: outputPath,
            fileName: outputName,
            mimeType: TARGET_FORMATS[targetFormat].mimeType
        };
    }

    if (isMarkdownDocument(entry.file) || isHtmlDocument(entry.file) || isPlainTextDocument(entry.file)) {
        await convertTextLike(entry, targetFormat, outputPath, context);
        return {
            path: outputPath,
            fileName: outputName,
            mimeType: TARGET_FORMATS[targetFormat].mimeType
        };
    }

    throw createError(`"${entry.file.name}" cannot be converted to ${targetFormat.toUpperCase()}.`);
}

module.exports = {
    TARGET_FORMATS,
    createError,
    sanitizeFilename,
    ensureExtension,
    stripExtension,
    buildOutputName,
    runCommand,
    convertEntryToTarget
};
