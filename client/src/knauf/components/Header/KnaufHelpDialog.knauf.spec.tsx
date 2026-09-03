import fs from 'fs';
import path from 'path';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import KnaufHelpDialog from './KnaufHelpDialog';

const SERVICE_REQUEST_URL =
  'https://knauf.service-now.com/it?id=sc_cat_item&sys_id=e16cc0b8dba806dc609363cad39619e4&table=sc_cat_item&searchTerm=knauf%20digital';
const INCIDENT_URL =
  'https://knauf.service-now.com/it?id=sc_cat_item&sys_id=3f1dd0320a0a0b99000a53f7604a2ef9';
let mockIsDark = false;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) =>
    key === 'com_nav_karl_help' ? 'KARL help & release notes' : key,
}));

jest.mock('@librechat/client', () => ({
  ThemeContext: jest.requireActual<typeof import('react')>('react').createContext({
    theme: 'light',
  }),
  isDark: () => mockIsDark,
  OGDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  OGDialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div role="dialog" className={className}>
      {children}
    </div>
  ),
  OGDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  OGDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

function loadHelpPage(theme?: 'light' | 'dark') {
  const html = fs.readFileSync(path.join(__dirname, '../../../../public/help/index.html'), 'utf8');
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const frameDocument = frame.contentDocument;
  const frameWindow = frame.contentWindow;
  if (frameDocument == null || frameWindow == null) {
    throw new Error('Help-page test frame is unavailable');
  }
  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
  const script = frameDocument.querySelector('script')?.textContent ?? '';
  const executableScript = theme
    ? script.replace('window.location.search', JSON.stringify(`?theme=${theme}`))
    : script;
  frameWindow.eval(executableScript);
  return { frameDocument, frameWindow };
}

describe('[knauf] KnaufHelpDialog — KK20-250 in-app release notes', () => {
  beforeEach(() => {
    mockIsDark = false;
  });

  it('renders the bundled help page inside the dialog', () => {
    render(<KnaufHelpDialog open onOpenChange={jest.fn()} />);

    expect(screen.getByRole('dialog')).toHaveClass('bg-surface-primary', 'text-text-primary');
    expect(screen.getByRole('heading', { name: 'KARL help & release notes' })).toBeInTheDocument();
    expect(screen.getByTitle('KARL help & release notes')).toHaveAttribute(
      'src',
      '/help/index.html?theme=light',
    );
  });

  it('passes the selected dark theme to the help page', () => {
    mockIsDark = true;

    render(<KnaufHelpDialog open onOpenChange={jest.fn()} />);

    expect(screen.getByTitle('KARL help & release notes')).toHaveAttribute(
      'src',
      '/help/index.html?theme=dark',
    );
  });

  it.each(['light', 'dark'] as const)(
    'applies an explicit %s theme inside the bundled help page',
    (theme) => {
      const { frameDocument } = loadHelpPage(theme);

      expect(frameDocument.documentElement).toHaveAttribute('data-theme', theme);
    },
  );

  it('keeps English as the help-page default and allows switching to German', () => {
    const { frameDocument, frameWindow } = loadHelpPage();
    const languageSelect = frameDocument.querySelector<HTMLSelectElement>('#language-select');
    const englishPage = frameDocument.querySelector<HTMLElement>('[data-language-page="en"]');
    const germanPage = frameDocument.querySelector<HTMLElement>('[data-language-page="de"]');

    expect(languageSelect?.value).toBe('en');
    expect(englishPage?.hidden).toBe(false);
    expect(germanPage?.hidden).toBe(true);

    if (languageSelect == null) {
      throw new Error('Language selector is missing');
    }
    languageSelect.value = 'de';
    fireEvent.change(languageSelect);

    expect(frameDocument.documentElement.lang).toBe('de');
    expect(englishPage?.hidden).toBe(true);
    expect(germanPage?.hidden).toBe(false);
  });

  it('provides distinct service-request and incident guidance', () => {
    const { frameDocument } = loadHelpPage();
    const links = Array.from(frameDocument.querySelectorAll<HTMLAnchorElement>('a'));
    const serviceRequest = links.find(
      (link) => link.getAttribute('href') === SERVICE_REQUEST_URL,
    );
    const incident = links.find((link) => link.getAttribute('href') === INCIDENT_URL);

    expect(serviceRequest).toBeDefined();
    expect(serviceRequest).toHaveAttribute('target', '_blank');
    expect(serviceRequest).toHaveAttribute('rel', 'noopener noreferrer');
    expect(incident).toBeDefined();
    expect(incident).toHaveAttribute('target', '_blank');
    expect(incident).toHaveAttribute('rel', 'noopener noreferrer');
    expect(frameDocument.body.textContent).toContain('Knauf.com - Digital Platform');
    expect(frameDocument.body.textContent).toContain('Chat-ID');
  });

  it('does not render content while closed', () => {
    render(<KnaufHelpDialog open={false} onOpenChange={jest.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
