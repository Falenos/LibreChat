// [knauf] KK20-221 seam test — the blob-download helpers must forward an optional
// AbortSignal into the axios request options so the preview dialog can cancel an
// in-flight large-file download on close. If the param is dropped, cancellation
// silently stops working (the request runs to completion in the background).
import { getFileDownload, getSharedFileDownload } from './data-service';
import request from './request';
// End [knauf]

jest.mock('./request', () => ({
  __esModule: true,
  default: {
    getResponse: jest.fn(() => Promise.resolve({ data: new Blob(), headers: {} })),
  },
}));

const mockGetResponse = (request as unknown as { getResponse: jest.Mock }).getResponse;

describe('[knauf] KK20-221 — download AbortSignal forwarding', () => {
  beforeEach(() => mockGetResponse.mockClear());

  it('forwards the signal to axios options in getFileDownload', async () => {
    const controller = new AbortController();
    await getFileDownload('user-1', 'file-1', controller.signal);
    expect(mockGetResponse).toHaveBeenCalledWith(
      expect.stringContaining('/download/user-1/file-1'),
      expect.objectContaining({ signal: controller.signal, responseType: 'blob' }),
    );
  });

  it('forwards the signal in getSharedFileDownload', async () => {
    const controller = new AbortController();
    await getSharedFileDownload('share-1', 'file-1', controller.signal);
    expect(mockGetResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('leaves signal undefined when omitted (back-compatible)', async () => {
    await getFileDownload('user-1', 'file-1');
    expect(mockGetResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: undefined }),
    );
  });
});
