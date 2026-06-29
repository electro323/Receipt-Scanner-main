export function detectOCRLanguage(text: string): string {
  const kannada = /[\u0C80-\u0CFF]/;
  const malayalam = /[\u0D00-\u0D7F]/;
  const hindi = /[\u0900-\u097F]/;

  if (kannada.test(text)) return 'kan+eng';
  if (malayalam.test(text)) return 'mal+eng';
  if (hindi.test(text)) return 'hin+eng';

  return 'eng';
}