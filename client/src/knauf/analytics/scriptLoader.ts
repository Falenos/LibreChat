type ScriptAttributes = Record<string, string | boolean | undefined>;

type LoadExternalScriptParams = {
  id: string;
  src: string;
  async?: boolean;
  attributes?: ScriptAttributes;
};

const pendingScripts = new Map<string, Promise<HTMLScriptElement>>();

export function loadExternalScript({
  id,
  src,
  async = true,
  attributes = {},
}: LoadExternalScriptParams): Promise<HTMLScriptElement> {
  const pending = pendingScripts.get(id);
  if (pending) {
    return pending;
  }

  const existing = document.getElementById(id);
  if (existing instanceof HTMLScriptElement) {
    return Promise.resolve(existing);
  }

  const script = document.createElement('script');
  script.id = id;
  script.src = src;
  script.type = 'text/javascript';
  script.async = async;

  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (value === true) {
      script.setAttribute(name, '');
      continue;
    }
    script.setAttribute(name, value);
  }

  const promise = new Promise<HTMLScriptElement>((resolve, reject) => {
    script.addEventListener('load', () => resolve(script), { once: true });
    script.addEventListener(
      'error',
      () => {
        pendingScripts.delete(id);
        reject(new Error(`Failed to load external script: ${src}`));
      },
      { once: true },
    );
  });

  pendingScripts.set(id, promise);
  document.head.appendChild(script);

  return promise;
}

export function resetExternalScriptForTest(id: string): void {
  pendingScripts.delete(id);
  document.getElementById(id)?.remove();
}
