import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from './api'

// Renders Claude output (hints / deep-dive) and stored hints as Markdown.
// Raw HTML is intentionally NOT rendered (no rehype-raw plugin), so model or
// authored text cannot inject markup — XSS-safe by default. Links open in the
// system browser via the main process instead of navigating the Electron
// window away from the app. Since the text is model-generated, only http(s)
// links are honored — file://, javascript:, and custom schemes are inert so a
// stray link can't reach `shell.openExternal` with a dangerous URL.
const isSafeHref = (href: string | undefined): href is string =>
  !!href && /^https?:\/\//i.test(href)

const components: Components = {
  a: ({ href, children }) =>
    isSafeHref(href) ? (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          void api.openExternal(href)
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    )
}

interface Props {
  children: string
  className?: string
}

export function Markdown({ children, className }: Props): JSX.Element {
  return (
    <div className={`md${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
