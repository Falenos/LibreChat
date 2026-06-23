import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  KnaufMessageActionRow,
  KnaufMessageHeading,
  KnaufMessageTimestamp,
} from './KnaufMessageChrome';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    key === 'com_knauf_powered_by_model' ? `Powered by ${values?.[0]}` : key,
}));

const formatExpectedTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

describe('KnaufMessageChrome', () => {
  it('renders assistant turns as Karl with model attribution as a hover tooltip', () => {
    render(
      <KnaufMessageHeading
        isCreatedByUser={false}
        label="GPT-5.4"
        fontSize="text-base"
        screenReaderPrefix="Assistant:"
      />,
    );

    expect(screen.getByText('Karl')).toHaveAttribute('title', 'Powered by GPT-5.4');
    expect(screen.queryByText('Powered by GPT-5.4')).not.toBeInTheDocument();
    expect(screen.getByText('Assistant:')).toHaveClass('sr-only');
  });

  it('keeps user turns named by their existing label', () => {
    render(
      <KnaufMessageHeading
        isCreatedByUser={true}
        label="Zahar"
        fontSize="text-base"
        screenReaderPrefix="User:"
      />,
    );

    expect(screen.getByText('Zahar')).toBeInTheDocument();
    expect(screen.getByText('Zahar')).not.toHaveAttribute('title');
    expect(screen.queryByText(/Powered by/)).not.toBeInTheDocument();
  });

  it('uses the static Karl attribution even when upstream passes Karl as the label', () => {
    render(
      <KnaufMessageHeading
        isCreatedByUser={false}
        label="KARL"
        fontSize="text-base"
        screenReaderPrefix="Assistant:"
      />,
    );

    expect(screen.getByText('Karl')).toHaveAttribute('title', 'Powered by GPT-5.4');
  });

  it('renders a semantic timestamp for valid message dates', () => {
    const createdAt = '2026-06-16T10:05:00.000Z';
    const expectedTimestamp = formatExpectedTimestamp(createdAt);
    const { container } = render(<KnaufMessageTimestamp createdAt={createdAt} />);
    const time = container.querySelector('time');

    expect(time).toHaveAttribute('dateTime', createdAt);
    expect(time).toHaveTextContent(expectedTimestamp);
    expect(time).toHaveAttribute('title', expectedTimestamp);
  });

  it('uses updatedAt when createdAt is unavailable', () => {
    const updatedAt = '2026-06-16T10:06:00.000Z';
    const expectedTimestamp = formatExpectedTimestamp(updatedAt);
    const { container } = render(<KnaufMessageTimestamp updatedAt={updatedAt} />);
    const time = container.querySelector('time');

    expect(time).toHaveAttribute('dateTime', updatedAt);
    expect(time).toHaveTextContent(expectedTimestamp);
  });

  it('omits invalid timestamps', () => {
    const { container } = render(<KnaufMessageTimestamp createdAt="not-a-date" />);

    expect(container.querySelector('time')).toBeNull();
  });

  it('keeps message actions and timestamp in the shared action row', () => {
    const createdAt = '2026-06-16T10:05:00.000Z';
    const expectedTimestamp = formatExpectedTimestamp(createdAt);

    render(
      <KnaufMessageActionRow createdAt={createdAt}>
        <button type="button" data-testid="copy-action" />
      </KnaufMessageActionRow>,
    );

    expect(screen.getByTestId('copy-action')).toBeInTheDocument();
    expect(screen.getByText(expectedTimestamp)).toHaveAttribute('dateTime', createdAt);
  });
});
