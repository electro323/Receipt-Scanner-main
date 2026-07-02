import { processReceiptWithAI } from './ai.service';

describe('processReceiptWithAI', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves OCR line breaks and ordering in the LLM prompt', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: '{}' }),
    } as any);
    const rawText = '  Depot-29\r\n\nRagigudda Temple\nTO\n  Depot-25 Gate\n';

    await processReceiptWithAI(rawText);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.prompt).toContain('OCR:\n  Depot-29\n\nRagigudda Temple\nTO\n  Depot-25 Gate\n');
    expect(body.prompt).not.toContain('Depot-29 Ragigudda Temple TO Depot-25 Gate');
  });
});
