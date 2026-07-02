import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export async function analyzeImageQuality(inputPath: string) {
  const { data, info } = await sharp(inputPath)
    .rotate()
    .resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const values = Array.from(data);
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / Math.max(values.length, 1);
  const stddev = Math.sqrt(variance);
  let gradientTotal = 0;
  let gradientCount = 0;

  for (let y = 0; y < info.height - 1; y++) {
    for (let x = 0; x < info.width - 1; x++) {
      const index = y * info.width + x;
      gradientTotal += Math.abs(data[index] - data[index + 1]);
      gradientTotal += Math.abs(data[index] - data[index + info.width]);
      gradientCount += 2;
    }
  }

  const edgeScore = gradientTotal / Math.max(gradientCount, 1);
  const isPlainOrBlank = stddev < 5 || edgeScore < 0.9;
  const isVeryBlurry = !isPlainOrBlank && edgeScore < 2.2 && stddev < 32;

  return {
    mean,
    stddev,
    edgeScore,
    isPlainOrBlank,
    isVeryBlurry,
  };
}

export type PreprocessMode = 'fast' | 'balanced' | 'strong';

async function createRoseSuppressedInkVariant(
  inputPath: string,
  outputPath: string,
  resizeWidth: number,
  threshold: boolean,
) {
  const { data, info } = await sharp(inputPath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .trim({ background: '#ffffff', threshold: 18 })
    .resize({ width: resizeWidth, withoutEnlargement: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const output = Buffer.alloc(info.width * info.height);

  for (let index = 0, pixel = 0; index < data.length; index += info.channels, pixel++) {
    const red = data[index] || 0;
    const green = data[index + 1] || red;
    const blue = data[index + 2] || red;
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const saturation = maxChannel - minChannel;
    const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
    const isRoseOrPink =
      red > 95 &&
      red > green * 1.08 &&
      red > blue * 1.08 &&
      saturation > 18 &&
      green > blue * 0.72;

    if (isRoseOrPink) {
      output[pixel] = 255;
    } else if (luminance < 140) {
      output[pixel] = Math.max(0, Math.round(luminance * 0.5));
    } else {
      output[pixel] = Math.min(255, Math.round(luminance * 1.12 + 14));
    }
  }

  const pipeline = sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 1,
    },
  })
    .normalize()
    .linear(1.45, -24)
    .sharpen({ sigma: 1.1 });

  if (threshold) {
    pipeline.threshold(172).median(1);
  }

  await pipeline.png().toFile(outputPath);
}

export async function preprocessImage(
  inputPath: string,
  mode: PreprocessMode = 'balanced',
): Promise<string[]> {
  // Temporarily bypass color/contrast/threshold preprocessing to compare OCR on the original image.
  void mode;
  return [inputPath];

  const resizeWidth = mode === 'fast' ? 1650 : mode === 'strong' ? 2200 : 1900;
  const normalizedBase = sharp(inputPath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: resizeWidth, withoutEnlargement: false })
    .grayscale();

  const croppedBase = sharp(inputPath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .trim({ background: '#ffffff', threshold: 18 })
    .resize({ width: resizeWidth, withoutEnlargement: false })
    .grayscale();

  const fastVariants = [
    {
      suffix: 'bw',
      pipeline: croppedBase.clone().normalize().linear(1.3, -14).threshold(168).median(1),
    },
    {
      suffix: 'clean',
      pipeline: croppedBase.clone().normalize().sharpen({ sigma: 1.05 }),
    },
    {
      suffix: 'high-contrast',
      pipeline: croppedBase.clone().normalize().linear(1.35, -18).sharpen({ sigma: 1.15 }),
    },
  ];

  const strongerVariants = [
    {
      suffix: 'denoise',
      pipeline: croppedBase.clone().normalize().median(1).sharpen({ sigma: 1.25 }),
    },
    {
      suffix: 'shadow-lift',
      pipeline: croppedBase.clone().modulate({ brightness: 1.08 }).normalize().linear(1.5, -26).sharpen({ sigma: 1.25 }),
    },
  ];

  const variants = mode === 'fast'
    ? fastVariants
    : mode === 'strong'
      ? [...fastVariants, ...strongerVariants]
      : [...fastVariants, strongerVariants[0], strongerVariants[1]];

  const outputPaths = await Promise.all(variants.map(async (variant) => {
    const outputPath = inputPath + '-' + variant.suffix + '.png';
    await variant.pipeline.png().toFile(outputPath);
    return outputPath;
  }));

  const bmtcCleanPath = inputPath + '-bmtc-clean.png';
  const bmtcInkPath = inputPath + '-bmtc-ink.png';
  await createRoseSuppressedInkVariant(inputPath, bmtcCleanPath, resizeWidth, false).catch((error) => {
    console.error('BMTC rose suppression preprocessing skipped:', error);
  });
  await createRoseSuppressedInkVariant(inputPath, bmtcInkPath, resizeWidth, true).catch((error) => {
    console.error('BMTC rose suppression preprocessing skipped:', error);
  });
  if (existsSync(bmtcCleanPath)) {
    outputPaths.unshift(bmtcCleanPath);
  }
  if (existsSync(bmtcInkPath)) {
    outputPaths.splice(1, 0, bmtcInkPath);
  }

  if (mode === 'fast') return outputPaths;

  const originalCleanPath = inputPath + '-original-clean.png';
  await normalizedBase.clone().normalize().sharpen({ sigma: 1.1 }).png().toFile(originalCleanPath);

  const advancedPaths = mode === 'strong'
    ? await runOpenCvReceiptPreprocess(inputPath)
    : [];

  return [...outputPaths, originalCleanPath, ...advancedPaths];
}

async function runOpenCvReceiptPreprocess(inputPath: string): Promise<string[]> {
  const scriptPath = join(process.cwd(), 'scripts', 'receipt_preprocess.py');

  if (!existsSync(scriptPath)) return [];

  for (const pythonCommand of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(
        pythonCommand,
        [scriptPath, inputPath],
        { timeout: 8000, maxBuffer: 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout.trim());

      if (Array.isArray(parsed)) return parsed.filter((path) => typeof path === 'string');
    } catch (error) {
      if (pythonCommand === 'python') {
        console.error('OpenCV receipt preprocessing skipped:', error);
      }
    }
  }

  return [];
}
