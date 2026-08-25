import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import Sources from '~/components/Web/Sources';
import { SearchContext } from '~/Providers';

jest.mock('~/data-provider', () => ({
  useFileDownload: () => ({ refetch: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: { count?: number; filename?: string }) => {
    if (key === 'com_sources_more_files') return `+${values?.count} files`;
    if (key === 'com_sources_download_aria_label') return `Download ${values?.filename}`;
    if (key === 'com_sources_agent_files') return 'Agent Files';
    if (key === 'com_sources_agent_file') return 'Agent File';
    if (key === 'com_sources_tab_files') return 'Files';
    if (key === 'com_sources_region_label') return 'Sources';
    if (key === 'com_ui_close') return 'Close';
    return key;
  },
}));

jest.mock('@librechat/client', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const DialogContext = React.createContext(false);
  const SetDialogContext = React.createContext<React.Dispatch<React.SetStateAction<boolean>>>(
    () => undefined,
  );

  return {
    AnimatedTabs: ({ tabs }: { tabs: Array<{ content: React.ReactNode }> }) => (
      <>
        {tabs.map(({ content }, index) => (
          <React.Fragment key={index}>{content}</React.Fragment>
        ))}
      </>
    ),
    OGDialog: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <DialogContext.Provider value={open}>
          <SetDialogContext.Provider value={setOpen}>{children}</SetDialogContext.Provider>
        </DialogContext.Provider>
      );
    },
    OGDialogClose: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    OGDialogContent: ({ children }: { children: React.ReactNode }) =>
      React.useContext(DialogContext) ? <div role="dialog">{children}</div> : null,
    OGDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    OGDialogTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
      const setOpen = React.useContext(SetDialogContext);
      return (
        <button type="button" onClick={() => setOpen(true)} {...props}>
          {children}
        </button>
      );
    },
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

describe('Sources file overflow (KK20-222)', () => {
  it('shows three of five files initially and all five through the overflow dialog', () => {
    const references = Array.from({ length: 5 }, (_, index) => ({
      fileId: `file-${index + 1}`,
      link: `#file-${index + 1}`,
      pages: [index + 1],
      title: `file-${index + 1}.pdf`,
      type: 'file',
    }));

    render(
      <RecoilRoot>
        <SearchContext.Provider value={{ searchResults: { 0: { references } } as never }}>
          <Sources messageId="message-1" conversationId="conversation-1" />
        </SearchContext.Provider>
      </RecoilRoot>,
    );

    expect(screen.getByText('file-1.pdf')).toBeInTheDocument();
    expect(screen.getByText('file-2.pdf')).toBeInTheDocument();
    expect(screen.getByText('file-3.pdf')).toBeInTheDocument();
    expect(screen.queryByText('file-4.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('file-5.pdf')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+2 files' }));

    const dialog = screen.getByRole('dialog');
    for (let index = 1; index <= 5; index++) {
      expect(within(dialog).getByText(`file-${index}.pdf`)).toBeInTheDocument();
    }
  });
});
