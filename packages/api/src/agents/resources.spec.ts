import type { IMongoFile } from '@librechat/data-schemas';
import { primeResources } from './resources';

describe('primeResources attachment scoping', () => {
  // [knauf] KK20-367 — historical tool files must not re-enter the model payload.
  it('keeps historical tool files out of request attachments', async () => {
    const currentFile = {
      file_id: 'current-file',
      filename: 'current.docx',
      context: '',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    } as IMongoFile;
    const historicalFile = {
      file_id: 'historical-file',
      filename: 'historical.pdf',
      context: '',
      type: 'application/pdf',
    } as IMongoFile;

    const result = await primeResources({
      req: { user: { id: 'user-1' } } as never,
      getFiles: jest.fn() as never,
      appConfig: {},
      agentId: 'agent-1',
      attachments: Promise.resolve([currentFile, historicalFile]) as never,
      tool_resources: undefined,
      requestFileSet: new Set([currentFile.file_id]),
    });

    expect(result.attachments).toEqual([currentFile, historicalFile]);
    expect(result.requestAttachments).toEqual([currentFile]);
    expect(result.agentContextAttachments).toBeUndefined();
  });
  // End [knauf]
});
