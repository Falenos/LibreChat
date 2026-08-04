// [knauf] KK20-199 — private Azure image request-shape and telemetry regressions.
import { getChatModelClass, Providers } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { buildLangfuseConfig } from '../run';

describe('private Azure image generation', () => {
  const privateImage = 'data:image/png;base64,aW1hZ2UtYnl0ZXM=';
  const messages = [
    new HumanMessage({
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: privateImage } },
      ],
    }),
  ];

  it('disables trace capture instead of exporting image bytes or identity', () => {
    const config = buildLangfuseConfig('tenant-secret', 'message-1', messages);

    expect(config).toEqual({ enabled: false });
    expect(JSON.stringify(config)).not.toContain(privateImage);
    expect(JSON.stringify(config)).not.toContain('tenant-secret');
  });

  it('uses the installed Azure Responses client input_image wire shape', async () => {
    const AzureChatModel = getChatModelClass(Providers.AZURE);
    const model = new AzureChatModel({
      model: 'model-router-chat',
      streaming: false,
      useResponsesApi: true,
      azureOpenAIApiKey: 'test-key',
      azureOpenAIApiVersion: '2025-04-01-preview',
      azureOpenAIApiInstanceName: 'test-instance',
      azureOpenAIApiDeploymentName: 'model-router-chat',
    });
    const captureRequest = jest.fn().mockRejectedValue(new Error('request captured'));
    model.responses.completionWithRetry = captureRequest;

    await expect(model.invoke(messages)).rejects.toThrow('request captured');

    expect(captureRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          expect.objectContaining({
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe this image' },
              expect.objectContaining({ type: 'input_image', image_url: privateImage }),
            ],
          }),
        ],
        model: 'model-router-chat',
        stream: false,
      }),
      expect.any(Object),
    );
  });

  it('preserves ordinary text-run correlation', () => {
    const config = buildLangfuseConfig('tenant-1', 'message-1', [new HumanMessage('hello')]);

    expect(config).toEqual({
      deterministicTraceId: true,
      metadata: {
        'librechat.source.message.id': 'message-1',
        'librechat.tenant.id': 'tenant-1',
      },
      tags: ['tenant:tenant-1'],
    });
  });
});
// End [knauf]
