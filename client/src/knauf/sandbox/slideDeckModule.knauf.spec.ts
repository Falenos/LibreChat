import ts from 'typescript';
import { sharedFiles } from '~/utils/artifacts';
import { knaufSlideDeckModule } from './slideDeckModule';

describe('[knauf] slide deck sandbox module', () => {
  it('mounts a syntactically valid data-only renderer', () => {
    const result = ts.transpileModule(knaufSlideDeckModule, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });

    expect(result.diagnostics).toEqual([]);
    expect(sharedFiles['/knauf/slides.tsx']).toBe(knaufSlideDeckModule);
    expect(knaufSlideDeckModule).toContain('export { KnaufSlideDeck }');
  });

  it('owns navigation, branding, accessibility, theme, and multi-page export', () => {
    expect(knaufSlideDeckModule).toContain('data-knauf-artifact-kind="slides"');
    expect(knaufSlideDeckModule).toContain('data-knauf-export-pages={total}');
    expect(knaufSlideDeckModule).toContain('data-knauf-export-next');
    expect(knaufSlideDeckModule).toContain("event.key === 'ArrowRight'");
    expect(knaufSlideDeckModule).toContain('aria-label="Slide navigation"');
    expect(knaufSlideDeckModule).toContain('backgroundColor: KNAUF.surface.card');
    expect(knaufSlideDeckModule).toContain('useKnaufTheme(useOsDarkMode())');
  });
});
