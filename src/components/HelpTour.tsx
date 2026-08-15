import {
  Check,
  ChevronLeft,
  ChevronRight,
  Lightbulb,
  X,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

export interface HelpTourStep {
  target?: string
  eyebrow: string
  title: string
  description: string
  tips?: string[]
  example?: ReactNode
}

interface HighlightRect {
  top: number
  left: number
  width: number
  height: number
}

interface CardPosition {
  top: number
  left: number
}

interface CardSize {
  width: number
  height: number
}

const GAP = 18
const EDGE = 14
const FALLBACK_CARD_SIZE: CardSize = { width: 360, height: 290 }

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function getCardPosition(rect: HighlightRect | null, measuredSize?: CardSize): CardPosition {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const cardWidth = Math.min(measuredSize?.width ?? FALLBACK_CARD_SIZE.width, viewportWidth - EDGE * 2)
  const cardHeight = Math.min(measuredSize?.height ?? FALLBACK_CARD_SIZE.height, viewportHeight - EDGE * 2)

  if (!rect) {
    return {
      top: Math.max(EDGE, (viewportHeight - cardHeight) / 2),
      left: Math.max(EDGE, (viewportWidth - cardWidth) / 2),
    }
  }

  const spaces = {
    right: viewportWidth - rect.left - rect.width,
    left: rect.left,
    bottom: viewportHeight - rect.top - rect.height,
    top: rect.top,
  }
  const horizontalFits = cardWidth + GAP
  const verticalFits = cardHeight + GAP
  const maximumTop = viewportHeight - cardHeight - EDGE
  const maximumLeft = viewportWidth - cardWidth - EDGE

  if (spaces.right >= horizontalFits) {
    return {
      top: clamp(rect.top + rect.height / 2 - cardHeight / 2, EDGE, maximumTop),
      left: clamp(rect.left + rect.width + GAP, EDGE, maximumLeft),
    }
  }
  if (spaces.left >= horizontalFits) {
    return {
      top: clamp(rect.top + rect.height / 2 - cardHeight / 2, EDGE, maximumTop),
      left: clamp(rect.left - cardWidth - GAP, EDGE, maximumLeft),
    }
  }
  if (spaces.bottom >= verticalFits || spaces.bottom >= spaces.top) {
    return {
      top: clamp(rect.top + rect.height + GAP, EDGE, maximumTop),
      left: clamp(rect.left + rect.width / 2 - cardWidth / 2, EDGE, maximumLeft),
    }
  }
  return {
    top: clamp(rect.top - cardHeight - GAP, EDGE, maximumTop),
    left: clamp(rect.left + rect.width / 2 - cardWidth / 2, EDGE, maximumLeft),
  }
}

export function HelpTour({
  id,
  open,
  steps,
  onClose,
}: {
  id: string
  open: boolean
  steps: HelpTourStep[]
  onClose: () => void
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [highlight, setHighlight] = useState<HighlightRect | null>(null)
  const [cardPosition, setCardPosition] = useState<CardPosition>({ top: EDGE, left: EDGE })
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const step = steps[stepIndex]

  useEffect(() => {
    if (!open) return
    setStepIndex(0)
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const layer = dialogRef.current?.closest<HTMLElement>('.help-tour')
    const backgroundElements = layer?.parentElement
      ? Array.from(layer.parentElement.children)
          .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer)
          .map((element) => ({
            element,
            inert: element.inert,
            ariaHidden: element.getAttribute('aria-hidden'),
          }))
      : []
    backgroundElements.forEach(({ element }) => {
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    })
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 30)
    return () => {
      window.clearTimeout(timer)
      backgroundElements.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      })
      previousFocusRef.current?.focus()
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !step) return

    const updatePosition = () => {
      const measuredSize = dialogRef.current
        ? { width: dialogRef.current.offsetWidth, height: dialogRef.current.offsetHeight }
        : undefined
      const target = step.target
        ? document.querySelector<HTMLElement>(`[data-help-id="${step.target}"]`)
        : null
      if (!target) {
        setHighlight(null)
        setCardPosition(getCardPosition(null, measuredSize))
        return
      }

      const bounds = target.getBoundingClientRect()
      const padding = window.innerWidth < 500 ? 4 : 7
      const top = Math.max(4, bounds.top - padding)
      const left = Math.max(4, bounds.left - padding)
      const right = Math.min(window.innerWidth - 4, bounds.right + padding)
      const bottom = Math.min(window.innerHeight - 4, bounds.bottom + padding)
      const rect = {
        top,
        left,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      }
      setHighlight(rect)
      setCardPosition(getCardPosition(rect, measuredSize))
    }

    updatePosition()
    const delayedUpdate = window.setTimeout(updatePosition, 180)
    const resizeObserver = new ResizeObserver(updatePosition)
    if (dialogRef.current) resizeObserver.observe(dialogRef.current)
    const target = step.target
      ? document.querySelector<HTMLElement>(`[data-help-id="${step.target}"]`)
      : null
    if (target) resizeObserver.observe(target)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.clearTimeout(delayedUpdate)
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [open, step])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (stepIndex === steps.length - 1) onClose()
        else setStepIndex((current) => current + 1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setStepIndex((current) => Math.max(0, current - 1))
      } else if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'),
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open, stepIndex, steps.length])

  if (!open || !step) return null

  const highlightStyle = highlight
    ? ({
        top: highlight.top,
        left: highlight.left,
        width: highlight.width,
        height: highlight.height,
      } satisfies CSSProperties)
    : undefined

  return (
    <div className={`help-tour ${highlight ? 'has-highlight' : 'is-centered'}`}>
      <div className="help-tour-blocker" aria-hidden="true" />
      {highlight && <div className="help-tour-spotlight" style={highlightStyle} aria-hidden="true" />}
      <section
        id={id}
        ref={dialogRef}
        className="help-tour-card"
        style={{ top: cardPosition.top, left: cardPosition.left }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-tour-title"
        aria-describedby="help-tour-description"
        tabIndex={-1}
      >
        <header className="help-tour-header">
          <div>
            <span className="help-tour-eyebrow">{step.eyebrow}</span>
            <span className="help-tour-count">{stepIndex + 1} / {steps.length}</span>
          </div>
          <button type="button" className="help-tour-close" onClick={onClose} aria-label="도움말 닫기">
            <X size={17} />
          </button>
        </header>

        <div className="help-tour-progress" aria-hidden="true">
          {steps.map((item, index) => (
            <span key={`${item.eyebrow}-${index}`} className={index <= stepIndex ? 'is-complete' : ''} />
          ))}
        </div>

        <div className="help-tour-copy">
          <h2 id="help-tour-title">{step.title}</h2>
          <p id="help-tour-description">{step.description}</p>
        </div>

        {step.example && <div className="help-tour-example">{step.example}</div>}

        {step.tips && step.tips.length > 0 && (
          <ul className="help-tour-tips">
            {step.tips.map((tip) => (
              <li key={tip}><Lightbulb size={13} /> <span>{tip}</span></li>
            ))}
          </ul>
        )}

        <footer className="help-tour-footer">
          <button
            type="button"
            className="help-tour-back"
            onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
            disabled={stepIndex === 0}
          >
            <ChevronLeft size={16} /> 이전
          </button>
          <span className="help-tour-key-hint">← → 키로 이동</span>
          <button
            type="button"
            className="help-tour-next"
            onClick={() => {
              if (stepIndex === steps.length - 1) onClose()
              else setStepIndex((current) => current + 1)
            }}
          >
            {stepIndex === steps.length - 1 ? (
              <><Check size={16} /> 시작하기</>
            ) : (
              <>다음 <ChevronRight size={16} /></>
            )}
          </button>
        </footer>
      </section>
    </div>
  )
}
