from pathlib import Path
import re

path = Path("src/components/chatInput/ChatInput.tsx")
s = path.read_text()

def once(old, new):
    global s
    if old not in s:
        raise SystemExit("composer patch anchor missing: " + old[:90])
    s = s.replace(old, new, 1)

once("import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'",
     "import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'")
once("import { useVoiceInput } from './useVoiceInput.js'\nimport { VoiceButton } from './VoiceButton.js'\nimport { Spectrum } from './Spectrum.js'",
     "import { PromptTools, WritingCanvas } from './PromptTools.js'")
once("+", "+") if False else None
once("语音输入 + 发送 / 停止", "快捷指令 + 画布 + 发送 / 停止")
once("  const [inputActive, setInputActive] = useState(false)\n  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)",
     "  const [canvasOpen, setCanvasOpen] = useState(false)")

voice_start = "  /** 转写结果插入到光标处，并把光标移到插入内容之后 */"
voice_end = "  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送"
a = s.find(voice_start)
b = s.find(voice_end, a)
if a < 0 or b < 0:
    raise SystemExit("voice hook block not found")
insert = """  const insertAtCursor = (value: string) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    const next = current.slice(0, start) + value + current.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + value.length, start + value.length)
    })
  }

"""
s = s[:a] + insert + s[b:]
once("!importingHistory && !streaming && voice.status === 'idle' && draftReady",
     "!importingHistory && !streaming && draftReady")
once("      voice.status !== 'idle' ||\n", "")
once("className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}",
     "className={styles.textarea}")

focus_block = """          onFocus={() => {
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
            setInputActive(true)
          }}
          onBlur={() => {
            blurTimerRef.current = setTimeout(() => {
              const wrapper = textareaRef.current?.closest('[data-chat-input-wrapper]')
              if (!wrapper?.contains(document.activeElement)) setInputActive(false)
            }, 220)
          }}
"""
once(focus_block, "")
once("        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}\n", "")

select_conditional = """          {inputActive ? (
            <Select
              value={selectedModel}
              options={MODEL_OPTIONS}
              ariaLabel="Model"
              disabled={streaming || importingHistory}
              onChange={(model) => {
                setSelectedModel(model)
                saveSessionModel(sessionId, model)
                requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
              }}
            />
          ) : null}
"""
select_always = """          <Select
            value={selectedModel}
            options={MODEL_OPTIONS}
            ariaLabel="Model"
            disabled={streaming || importingHistory}
            onChange={(model) => {
              setSelectedModel(model)
              saveSessionModel(sessionId, model)
            }}
          />
"""
once(select_conditional, select_always)

voice_button = """          <VoiceButton
            status={voice.status}
            disabled={!voice.available}
            seconds={voice.seconds}
            onClick={() => {
              if (
                voice.status !== 'idle' ||
                (!useChatStore.getState().importingHistory && ensureApiKey())
              ) {
                void voice.toggle()
              }
            }}
          />
"""
once(voice_button, "          <PromptTools onInsert={insertAtCursor} onOpenCanvas={() => setCanvasOpen(true)} />\n")

once("      {dragging ? <DragMask /> : null}\n",
     """      {dragging ? <DragMask /> : null}
      {canvasOpen ? (
        <WritingCanvas
          value={text}
          onChange={(value) => setText(value)}
          onClose={() => setCanvasOpen(false)}
        />
      ) : null}
""")

path.write_text(s)
