const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { SystemRoles } = require('librechat-data-provider');

jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processAgentFileUpload: jest.fn().mockImplementation(async ({ res }) =>
    res.status(200).json({
      message: 'Agent file uploaded and processed successfully',
      file_id: 'test-file-id',
    }),
  ),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({})),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn().mockResolvedValue(false),
}));

jest.mock('sharp', () =>
  jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({}),
    toFormat: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.alloc(0)),
  })),
);

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  verifyAgentUploadPermission: jest.fn(
    jest.requireActual('@librechat/api').verifyAgentUploadPermission,
  ),
  refreshS3FileUrls: jest.fn(),
  detectEncryptedFileAtPath: jest.fn((filePath, mimeType) => {
    const actual = jest.requireActual('@librechat/api');
    return mimeType === 'application/pdf'
      ? Promise.resolve({ encrypted: false })
      : actual.detectEncryptedFileAtPath(filePath, mimeType);
  }),
}));

jest.mock('@knauf/knauf/server/pdfAccessProbe', () => ({
  isPdfFileAtPath: jest.fn().mockResolvedValue(false),
  probePdfAccess: jest.fn().mockResolvedValue({ result: 'readable' }),
  PDF_PROBE_UNAVAILABLE_CODE: 'com_knauf_error_pdf_probe_unavailable',
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    get: jest.fn(),
    set: jest.fn(),
  })),
}));

jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      unlink: jest.fn().mockResolvedValue(undefined),
    },
  };
});

const { processAgentFileUpload } = require('~/server/services/Files/process');
const { verifyAgentUploadPermission } = require('@librechat/api');
const { isPdfFileAtPath, probePdfAccess } = require('@knauf/knauf/server/pdfAccessProbe');
const router = require('~/server/routes/files/files');

describe('POST /files PDF access classification', () => {
  const tmpFiles = [];

  const writeTmp = (buffer, name) => {
    const filePath = path.join(os.tmpdir(), `knauf-pdf-route-${uuidv4()}-${name}`);
    fs.writeFileSync(filePath, buffer);
    tmpFiles.push(filePath);
    return filePath;
  };

  const buildApp = (file) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.file = file;
      req.file_id = uuidv4();
      next();
    });
    app.use((req, _res, next) => {
      req.user = { id: new mongoose.Types.ObjectId().toString(), role: SystemRoles.USER };
      req.app = { locals: {} };
      req.config = { fileStrategy: 'local' };
      next();
    });
    app.use('/files', router);
    return app;
  };

  const createFile = (buffer, name, mimetype = 'application/pdf') => ({
    originalname: name,
    mimetype,
    size: buffer.length,
    path: writeTmp(buffer, name),
  });

  afterAll(() => {
    for (const filePath of tmpFiles) {
      fs.rmSync(filePath, { force: true });
    }
  });

  beforeEach(() => {
    processAgentFileUpload.mockClear();
    verifyAgentUploadPermission.mockClear();
    verifyAgentUploadPermission.mockImplementation(
      jest.requireActual('@librechat/api').verifyAgentUploadPermission,
    );
    isPdfFileAtPath.mockClear();
    isPdfFileAtPath.mockResolvedValue(false);
    probePdfAccess.mockClear();
    probePdfAccess.mockResolvedValue({ result: 'readable' });
  });

  it('allows a readable permission-encrypted PDF through the File Search gate', async () => {
    const pdf = Buffer.from('%PDF-1.6\n... /Encrypt 1 0 R ... trailer\n%%EOF', 'binary');
    const file = createFile(pdf, 'permission-encrypted.pdf');

    const response = await request(buildApp(file))
      .post('/files')
      .send({ endpoint: 'agents', tool_resource: 'file_search' });

    expect(probePdfAccess).toHaveBeenCalledWith(file.path);
    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalledTimes(1);
  });

  it('classifies a PDF whose declared multipart MIME type is spoofed', async () => {
    isPdfFileAtPath.mockResolvedValue(true);
    probePdfAccess.mockResolvedValue({ result: 'password_required' });
    const file = createFile(
      Buffer.from('prefix%PDF-1.7\nfixture\n%%EOF', 'binary'),
      'spoofed.txt',
      'text/plain',
    );

    const response = await request(buildApp(file))
      .post('/files')
      .send({ endpoint: 'agents', tool_resource: 'file_search', file_id: uuidv4() });

    expect(isPdfFileAtPath).toHaveBeenCalledWith(file.path);
    expect(probePdfAccess).toHaveBeenCalledWith(file.path);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('com_knauf_error_pdf_password_required');
    expect(processAgentFileUpload).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized upload before starting PDF classification', async () => {
    verifyAgentUploadPermission.mockImplementationOnce(({ res }) => {
      res.status(403).json({ message: 'Forbidden' });
      return Promise.resolve(true);
    });
    const file = createFile(
      Buffer.from('%PDF-1.7\nfixture\n%%EOF', 'binary'),
      'authorization-order.pdf',
    );

    const response = await request(buildApp(file))
      .post('/files')
      .send({ endpoint: 'agents', tool_resource: 'file_search', file_id: uuidv4() });

    expect(response.status).toBe(403);
    expect(verifyAgentUploadPermission).toHaveBeenCalledTimes(1);
    expect(probePdfAccess).not.toHaveBeenCalled();
    expect(processAgentFileUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['password_required', 'com_knauf_error_pdf_password_required'],
    ['invalid', 'com_knauf_error_pdf_invalid'],
  ])('returns 422 for %s PDFs', async (result, code) => {
    probePdfAccess.mockResolvedValue({ result });
    const file = createFile(
      Buffer.from('%PDF-1.7\nfixture\n%%EOF', 'binary'),
      `${result}.pdf`,
    );

    const response = await request(buildApp(file))
      .post('/files')
      .send({ endpoint: 'agents', tool_resource: 'file_search', file_id: uuidv4() });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ message: code, code });
    expect(processAgentFileUpload).not.toHaveBeenCalled();
  });

  it('returns retryable 503 when the PDF probe is unavailable', async () => {
    const error = new Error('com_knauf_error_pdf_probe_unavailable');
    error.code = 'com_knauf_error_pdf_probe_unavailable';
    probePdfAccess.mockRejectedValue(error);
    const file = createFile(
      Buffer.from('%PDF-1.7\nfixture\n%%EOF', 'binary'),
      'unavailable.pdf',
    );

    const response = await request(buildApp(file))
      .post('/files')
      .send({ endpoint: 'agents', tool_resource: 'file_search', file_id: uuidv4() });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('com_knauf_error_pdf_probe_unavailable');
  });

  it('does not probe PDFs outside non-Assistants File Search', async () => {
    const file = createFile(Buffer.from('%PDF-1.7\nfixture\n%%EOF', 'binary'), 'chat.pdf');

    const response = await request(buildApp(file))
      .post('/files')
      .send({ endpoint: 'azureOpenAI' });

    expect(probePdfAccess).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(processAgentFileUpload).toHaveBeenCalledTimes(1);
  });

  it('retains global encrypted-OOXML rejection', async () => {
    const cfbf = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    const file = createFile(
      cfbf,
      'encrypted.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    const response = await request(buildApp(file))
      .post('/files')
      .send({ endpoint: 'azureOpenAI', file_id: uuidv4() });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('com_knauf_error_file_encrypted');
  });
});
