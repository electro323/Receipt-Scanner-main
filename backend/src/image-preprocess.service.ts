import sharp from 'sharp';

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

export async function preprocessImage(inputPath: string): Promise<string[]> {
  const normalizedBase = sharp(inputPath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: 1800, withoutEnlargement: false })
    .grayscale();

  const croppedBase = sharp(inputPath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .trim({ background: '#ffffff', threshold: 18 })
    .resize({ width: 1800, withoutEnlargement: false })
    .grayscale();

  const variants = [
    {
      suffix: 'clean',
      pipeline: croppedBase.clone().normalize().median(1).sharpen({ sigma: 1.05 }),
    },
    {
      suffix: 'high-contrast',
      pipeline: croppedBase.clone().normalize().linear(1.45, -24).sharpen({ sigma: 1.25 }),
    },
    {
      suffix: 'bw',
      pipeline: croppedBase.clone().normalize().linear(1.25, -12).threshold(168).median(1),
    },
  ];

  const outputPaths = await Promise.all(variants.map(async (variant) => {
    const outputPath = inputPath + '-' + variant.suffix + '.png';
    await variant.pipeline.png().toFile(outputPath);
    return outputPath;
  }));

  const originalCleanPath = inputPath + '-original-clean.png';
  await normalizedBase.clone().normalize().sharpen({ sigma: 1.1 }).png().toFile(originalCleanPath);

  return [...outputPaths, originalCleanPath];
}
