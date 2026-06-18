import React from 'react';
import { render, screen } from '@testing-library/react';
import KnaufLogoAvatar from './KnaufLogoAvatar';

describe('[knauf] KnaufLogoAvatar', () => {
  it('renders the wordmark with contained sizing inside a circular avatar shell', () => {
    render(<KnaufLogoAvatar className="size-12" />);

    const logo = screen.getByAltText('Knauf');
    expect(logo).toHaveAttribute('src', '/assets/knauf-logo.png');
    expect(logo).toHaveClass('object-contain');
    expect(logo).toHaveClass('w-[72%]');
    expect(logo.parentElement).toHaveClass('rounded-full');
  });
});
