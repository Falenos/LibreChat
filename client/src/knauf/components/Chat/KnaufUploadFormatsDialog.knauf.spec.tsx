/**
 * [knauf] Seam test for the "Supported file types" dialog. Mocks OGDialog (to
 * honour the `open` prop) and `useLocalize` (key → key), then pins the rendered
 * structure: the format groups, the limits line, and the three legacy
 * conversion steps. KK20-190 (upload-guidance follow-up).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import KnaufUploadFormatsDialog from './KnaufUploadFormatsDialog';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  __esModule: true,
  OGDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="og-dialog">{children}</div> : null,
  OGDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

describe('[knauf] KnaufUploadFormatsDialog', () => {
  it('renders nothing when closed', () => {
    render(<KnaufUploadFormatsDialog open={false} onOpenChange={jest.fn()} />);
    expect(screen.queryByTestId('og-dialog')).toBeNull();
  });

  it('renders title, format groups, limits, and legacy conversion steps when open', () => {
    render(<KnaufUploadFormatsDialog open={true} onOpenChange={jest.fn()} />);

    // title
    expect(screen.getByText('com_knauf_upload_formats_title')).toBeInTheDocument();

    // three accepted-format groups (label + items)
    for (const key of [
      'com_knauf_upload_formats_documents_label',
      'com_knauf_upload_formats_documents_items',
      'com_knauf_upload_formats_data_label',
      'com_knauf_upload_formats_data_items',
      'com_knauf_upload_formats_images_label',
      'com_knauf_upload_formats_images_items',
      'com_knauf_upload_formats_svg_label',
      'com_knauf_upload_formats_svg_items',
    ]) {
      expect(screen.getByText(new RegExp(key))).toBeInTheDocument();
    }

    // limits line
    expect(screen.getByText('com_knauf_upload_formats_limits')).toBeInTheDocument();

    // legacy section: title + intro + one bullet per legacy format
    expect(screen.getByText('com_knauf_upload_formats_legacy_title')).toBeInTheDocument();
    expect(screen.getByText('com_knauf_upload_formats_legacy_intro')).toBeInTheDocument();
    expect(screen.getByText('com_knauf_upload_formats_legacy_doc')).toBeInTheDocument();
    expect(screen.getByText('com_knauf_upload_formats_legacy_xls')).toBeInTheDocument();
    expect(screen.getByText('com_knauf_upload_formats_legacy_ppt')).toBeInTheDocument();
  });
});
