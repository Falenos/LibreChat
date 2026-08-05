import { getSlideDeckContractError } from './slideDeckContract';

describe('[knauf] generated slide deck contract', () => {
  it('accepts the platform renderer and ignores non-deck artifacts', () => {
    expect(
      getSlideDeckContractError(
        "import { KnaufSlideDeck } from '/knauf/slides'; export default () => <KnaufSlideDeck slides={[]} />;",
      ),
    ).toBeNull();
    expect(getSlideDeckContractError('export default () => <main>Report</main>;')).toBeNull();
  });

  it('rejects the exact class of compiling but broken legacy deck', () => {
    const error = getSlideDeckContractError(`
      export default function Deck() {
        return <div data-knauf-export-pages>
          <div style={{ display: 'none' }}>[Source](https://example.com)</div>
        </div>;
      }
    `);

    expect(error?.title).toBe('Slide deck contract failed');
    expect(error?.message).toContain('has no numeric value');
    expect(error?.message).toContain('has no data-knauf-export-next control');
    expect(error?.message).toContain('permanently hidden');
    expect(error?.message).toContain('Markdown links');
    expect(error?.message).toContain("from '/knauf/slides'");
  });

  it('accepts a valid legacy deck contract during migration', () => {
    expect(
      getSlideDeckContractError(`
        export default () => <div data-knauf-export-pages={3}>
          <button data-knauf-export-next>Next</button>
        </div>;
      `),
    ).toBeNull();
  });
});
