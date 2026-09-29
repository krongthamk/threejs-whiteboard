export interface TextEditOptions {
  parent: HTMLElement
  text: string
  x: number
  y: number
  width: number
  fontSize: number
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
  rotation?: number
  zoom?: number
  color: string
  onCommit(text: string): void
  onCancel(): void
}

/** Native DOM owns editing semantics; the document receives exactly one commit. */
export function openTextEditor(options: TextEditOptions) {
  const input = document.createElement('div')
  input.contentEditable = 'plaintext-only'
  input.role = 'textbox'
  input.setAttribute('aria-label', 'Edit text')
  input.setAttribute('aria-multiline', 'true')
  input.spellcheck = true
  input.textContent = options.text
  Object.assign(input.style, {
    position: 'absolute', left: `${options.x}px`, top: `${options.y}px`,
    width: `${options.width}px`, minHeight: '1.2em', padding: '0', margin: '0',
    fontSize: `${options.fontSize}px`, lineHeight: '1.25', fontFamily: `${options.fontFamily ?? 'Inter'}, "Noto Sans JP", sans-serif`, color: options.color,
    textAlign: options.align ?? 'left',
    transform: `rotate(${options.rotation ?? 0}rad) scale(${options.zoom ?? 1})`,
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', outline: '2px solid #4265cf',
    background: '#fff', zIndex: '5', transformOrigin: 'top left',
  })
  let composing = false
  let blurPending = false
  let closed = false
  const finish = (commit: boolean) => {
    if (closed) return
    closed = true
    const text = input.innerText.replace(/\r\n/g, '\n')
    input.remove()
    if (commit) options.onCommit(text)
    else options.onCancel()
  }
  input.addEventListener('compositionstart', () => { composing = true })
  input.addEventListener('compositionend', () => {
    composing = false
    if (blurPending) finish(true)
  })
  input.addEventListener('blur', () => {
    if (composing) blurPending = true
    else finish(true)
  })
  input.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Escape' && !composing) { event.preventDefault(); finish(false) }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !composing) {
      event.preventDefault(); finish(true)
    }
  })
  input.addEventListener('pointerdown', (event) => event.stopPropagation())
  options.parent.append(input)
  input.focus()
  const range = document.createRange()
  range.selectNodeContents(input)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return { element: input, commit: () => finish(true), cancel: () => finish(false) }
}
