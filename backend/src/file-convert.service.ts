import * as fs from 'fs/promises';
import * as path from 'path';
import { fromPath } from 'pdf2pic';
import heicConvert from 'heic-convert';

const { PDFParse } = require('pdf-parse');

export async function ensureHeicJpegPreview(filePath: string): Promise<string> {
  const outputPath = filePath + '.jpg';

  try {
    await fs.access(outputPath);
    return outputPath;
  } catch {
    const inputBuffer = await fs.readFile(filePath);

    const outputBuffer = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 1,
    });

    await fs.writeFile(outputPath, Buffer.from(outputBuffer));
    return outputPath;
  }
}

export async function prepareFileForOCR(file: any): Promise<string[]> {
  const ext = path.extname(file.originalname).toLowerCase();

  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    return [file.path];
  }

  if (ext === '.heic') {
    return [await ensureHeicJpegPreview(file.path)];
  }

  if (ext === '.pdf') {
    const outputDir = path.join(process.cwd(), 'uploads', 'pdf-pages');

    await fs.mkdir(outputDir, { recursive: true });

    const converter = fromPath(file.path, {
      density: 300,
      saveFilename: path.basename(file.path),
      savePath: outputDir,
      format: 'png',
      width: 1800,
    });

    const pages = await converter.bulk(-1, {
      responseType: 'image',
    });

    return pages
      .map((page: any) => page.path)
      .filter(Boolean);
  }

  throw new Error('Unsupported file format');
}

export async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);

  const parser = new PDFParse({
    data: buffer,
  });

  const result = await parser.getText();

  await parser.destroy();

  return result.text.trim();
}
