import type { ToolCallRequest } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import {
  isKnaufModelOnlyArtifact,
  KNAUF_VISUAL_QA_MAX_BYTES,
  readKnaufSandboxImage,
  sniffRasterMime,
  toSandboxRelativePath,
} from './visualQa';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const ON = { KNAUF_CODE_VISUAL_QA_ENABLED: 'true' };
const CODE = { codeEnvAvailable: true };

function call(files: Array<Record<string, unknown>>, path = '/mnt/data/_karl_qa/sheet-1.png') {
  return {
    id: `call-${Math.random()}`,
    name: 'read_file',
    args: { path },
    codeSessionContext: { session_id: 'karl-x', files },
  } as unknown as ToolCallRequest;
}
const render = (name = '_karl_qa/sheet-1.png', extra: Record<string, unknown> = {}) => ({
  id: 'file-1',
  name,
  storage_session_id: 'karl-00000000000000000000000000000000',
  kind: 'user',
  ...extra,
});
const newReq = () => ({ user: { id: 'user-1' } }) as unknown as ServerRequest;

describe('[knauf] visual QA read_file seam (KK20-397)', () => {
  it('normalises sandbox paths and rejects anything outside /mnt/data', () => {
    expect(toSandboxRelativePath('/mnt/data/_karl_qa/a.png')).toBe('_karl_qa/a.png');
    expect(toSandboxRelativePath('./_karl_qa/a.png')).toBe('_karl_qa/a.png');
    expect(toSandboxRelativePath('chart.png')).toBe('chart.png');
    for (const bad of [
      '/etc/passwd.png',
      '/mnt/data/../x.png',
      'a//b.png',
      'a\\b.png',
      'a\0.png',
      '',
    ]) {
      expect(toSandboxRelativePath(bad)).toBeNull();
    }
  });

  it('identifies raster images by content, not by name', () => {
    expect(sniffRasterMime(PNG)).toBe('image/png');
    expect(sniffRasterMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffRasterMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffRasterMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffRasterMime(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffRasterMime(Buffer.from('<svg/>'))).toBeNull();
  });

  it('returns a render as a model-only image artifact, fetched by its staged ref', async () => {
    const download = jest.fn(async () => PNG);
    const req = newReq();
    const result = await readKnaufSandboxImage({
      tc: call([render('_karl_qa/sheet-1.png', { id: 'old' }), render()]),
      path: '/mnt/data/_karl_qa/sheet-1.png',
      mergedConfigurable: CODE,
      req,
      env: ON,
      download,
    });
    expect(download).toHaveBeenCalledWith({
      req,
      ref: { id: 'file-1', storage_session_id: 'karl-00000000000000000000000000000000' },
      maxBytes: KNAUF_VISUAL_QA_MAX_BYTES,
    });
    expect(result?.status).toBe('success');
    expect(result?.content).toContain('Image: /mnt/data/_karl_qa/sheet-1.png');
    expect(isKnaufModelOnlyArtifact(result?.artifact)).toBe(true);
    const part = (result?.artifact as { content: Array<{ image_url: { url: string } }> })
      .content[0];
    expect(part.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('leaves everything that is not its business to upstream read_file', async () => {
    const download = jest.fn(async () => PNG);
    const base = { mergedConfigurable: CODE, req: newReq(), env: ON, download };
    await expect(
      readKnaufSandboxImage({
        ...base,
        tc: call([render()]),
        path: 'skills/karl-brand/assets/logo.png',
      }),
    ).resolves.toBeNull();
    await expect(
      readKnaufSandboxImage({ ...base, tc: call([render()]), path: '/mnt/data/report.docx' }),
    ).resolves.toBeNull();
    await expect(
      readKnaufSandboxImage({
        ...base,
        tc: call([render()]),
        mergedConfigurable: {},
        path: '/mnt/data/_karl_qa/sheet-1.png',
      }),
    ).resolves.toBeNull();
    // An ordinary image with no staged ref: upstream's message stays accurate.
    await expect(
      readKnaufSandboxImage({ ...base, tc: call([]), path: '/mnt/data/chart.png' }),
    ).resolves.toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('never uses a skill-kind or agent-kind ref, only files the user’s run produced', async () => {
    const download = jest.fn(async () => PNG);
    const result = await readKnaufSandboxImage({
      tc: call([render('_karl_qa/sheet-1.png', { kind: 'skill' })]),
      path: '/mnt/data/_karl_qa/sheet-1.png',
      mergedConfigurable: CODE,
      req: newReq(),
      env: ON,
      download,
    });
    expect(result?.status).toBe('error');
    expect(download).not.toHaveBeenCalled();
  });

  it('says plainly that inspection is off when the flag is off, for a QA render', async () => {
    const result = await readKnaufSandboxImage({
      tc: call([render()]),
      path: '/mnt/data/_karl_qa/sheet-1.png',
      mergedConfigurable: CODE,
      req: newReq(),
      env: {},
    });
    expect(result?.status).toBe('error');
    expect(result?.errorMessage).toContain('not enabled');
  });

  it('refuses non-images and caps images per response, refunding failed fetches', async () => {
    const req = newReq();
    const base = {
      mergedConfigurable: CODE,
      req,
      env: { ...ON, KNAUF_CODE_VISUAL_QA_MAX_IMAGES: '2' },
    };
    const pdf = await readKnaufSandboxImage({
      ...base,
      tc: call([render()]),
      path: '/mnt/data/_karl_qa/sheet-1.png',
      download: async () => Buffer.from('%PDF-1.7'),
    });
    expect(pdf?.status).toBe('error');
    const failed = await readKnaufSandboxImage({
      ...base,
      tc: call([render()]),
      path: '/mnt/data/_karl_qa/sheet-1.png',
      download: async () => {
        throw new Error('maxContentLength exceeded');
      },
    });
    expect(failed?.errorMessage).toContain('4 MiB');
    const ok = async () =>
      readKnaufSandboxImage({
        ...base,
        tc: call([render()]),
        path: '/mnt/data/_karl_qa/sheet-1.png',
        download: async () => PNG,
      });
    expect((await ok())?.status).toBe('success');
    expect((await ok())?.status).toBe('success');
    const third = await ok();
    expect(third?.status).toBe('error');
    expect(third?.errorMessage).toContain('limit reached (2 images');
  });
});

/* [knauf] KK20-397 — SDK contract. The image reaches the model only because
 * @librechat/agents' formatArtifactPayload lifts a ToolMessage's `artifact.content` into a
 * follow-up HumanMessage. If an SDK bump changes that, visual QA silently goes blind. */
describe('[knauf] visual QA artifact reaches the model (SDK contract)', () => {
  it('formatArtifactPayload turns the returned artifact into an image the model sees', async () => {
    const { formatArtifactPayload } = await import('@librechat/agents');
    const { AIMessageChunk, HumanMessage, ToolMessage } = await import('@langchain/core/messages');
    const result = await readKnaufSandboxImage({
      tc: call([render()]),
      path: '/mnt/data/_karl_qa/sheet-1.png',
      mergedConfigurable: CODE,
      req: newReq(),
      env: ON,
      download: async () => PNG,
    });
    const messages = [
      new AIMessageChunk({
        content: '',
        tool_calls: [
          { id: 'tc-1', name: 'read_file', args: { path: '/mnt/data/_karl_qa/sheet-1.png' } },
        ],
      }),
      new ToolMessage({
        tool_call_id: 'tc-1',
        content: String(result?.content),
        artifact: result?.artifact,
      }),
    ];
    formatArtifactPayload(messages);
    const last = messages[messages.length - 1];
    expect(last).toBeInstanceOf(HumanMessage);
    expect(JSON.stringify(last.content)).toContain('data:image/png;base64,');
  });
});
