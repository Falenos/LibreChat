import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import Home from './page'

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const {
      priority,
      fill,
      quality,
      placeholder,
      blurDataURL,
      loader,
      unoptimized,
      overrideSrc,
      ...rest
    } = props
    void priority
    void fill
    void quality
    void placeholder
    void blurDataURL
    void loader
    void unoptimized
    void overrideSrc
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...rest} alt={(rest.alt as string) || ''} />
  },
}))

describe('Home', () => {
  it('renders without crashing', () => {
    render(<Home />)
    expect(screen.getByAltText('Next.js logo')).toBeInTheDocument()
  })

  it('renders the documentation link', () => {
    render(<Home />)
    const link = screen.getByRole('link', { name: /documentation/i })
    expect(link).toHaveAttribute('href', expect.stringContaining('nextjs.org/docs'))
  })
})
