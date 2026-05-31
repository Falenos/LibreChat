import { loadExternalScript, resetExternalScriptForTest } from './scriptLoader';

describe('loadExternalScript', () => {
  afterEach(() => {
    resetExternalScriptForTest('test-script');
  });

  it('adds a script with custom attributes', async () => {
    const promise = loadExternalScript({
      id: 'test-script',
      src: 'https://example.test/script.js',
      attributes: {
        charset: 'UTF-8',
        'data-domain-script': 'domain-script',
        'data-document-language': 'true',
      },
    });
    const script = document.getElementById('test-script') as HTMLScriptElement;

    expect(script).toBeInstanceOf(HTMLScriptElement);
    expect(script.src).toBe('https://example.test/script.js');
    expect(script).toHaveAttribute('charset', 'UTF-8');
    expect(script).toHaveAttribute('data-domain-script', 'domain-script');
    expect(script).toHaveAttribute('data-document-language', 'true');

    script.dispatchEvent(new Event('load'));
    await expect(promise).resolves.toBe(script);
  });

  it('dedupes pending scripts by id', () => {
    const first = loadExternalScript({
      id: 'test-script',
      src: 'https://example.test/script.js',
    });
    const second = loadExternalScript({
      id: 'test-script',
      src: 'https://example.test/script.js',
    });

    expect(second).toBe(first);
    expect(document.querySelectorAll('#test-script')).toHaveLength(1);
  });
});
