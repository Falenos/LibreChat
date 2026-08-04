import type { Config } from '../config.js';
import type { SupportedLang } from '../validate.js';

/** lang → session pool. py → PythonLTS, bash → Shell; anything else is 501 upstream. */
export function poolFor(config: Config, lang: SupportedLang): string {
  return lang === 'py' ? config.aca.poolEndpointPy : config.aca.poolEndpointSh;
}
