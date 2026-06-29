export function detectOCRLanguage(text: string): string {
  const kannada = /[\u0C80-\u0CFF]/;
  const malayalam = /[\u0D00-\u0D7F]/;
  const hindi = /[\u0900-\u097F]/;

  if (kannada.test(text)) return 'kan+eng';
  if (malayalam.test(text)) return 'mal+eng';
  if (hindi.test(text)) return 'hin+eng';

  return 'eng';
}

export function buildTesseractLanguage(languages?: string | string[]): string {
  const requested = Array.isArray(languages)
    ? languages
    : String(languages || '')
        .split(/[,+\s]/)
        .map((language) => language.trim())
        .filter(Boolean);

  const supported = new Set(['eng', 'kan', 'mal', 'hin']);
  const selected = requested.filter((language) => supported.has(language));

  if (!selected.includes('eng')) {
    selected.unshift('eng');
  }

  return Array.from(new Set(selected.length ? selected : ['eng', 'kan', 'mal', 'hin'])).join('+');
}
