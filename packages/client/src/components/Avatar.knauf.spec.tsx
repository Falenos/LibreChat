// [knauf] Seam test: package Avatar fallback must use Knauf dark blue.
import { render } from '@testing-library/react';
import Avatar from './Avatar';

describe('Avatar — Knauf fallback colour', () => {
  it('renders the empty-user fallback with Knauf dark blue', () => {
    const { container } = render(<Avatar size={32} showDefaultWhenEmpty />);
    const fallback = container.firstElementChild as HTMLElement;

    expect(fallback).toHaveStyle({ backgroundColor: 'rgb(33, 58, 117)' });
  });
});
// End [knauf]
