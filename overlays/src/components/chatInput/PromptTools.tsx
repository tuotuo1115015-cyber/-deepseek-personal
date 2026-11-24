import { useEffect, useMemo, useState } from 'react'
import styles from './PromptTools.module.css'

type Shortcut = { id: string; title: string; category: string; content: string }
const STORAGE_KEY = 'deepseek-personal:prompt-shortcuts:v1'
const DEFAULTS: Shortcut[] = [
  { id: 'core', title: '核心文本', category: '标记', content: '((这是核心文本))' },
  { id: 'emphasis', title: '强调标记', category: '标记', content: '【重点】' },
  { id: 'js', title: 'JS 规则块', category: '代码', content: '```js\n// 在这里填写规则\n```' },
  { id: 'role', title: '角色规则', category: '角色', content: '【角色规则】\n- 保持角色设定一致\n- 不擅自替角色补充动机\n' },
]
const readShortcuts = (): Shortcut[] => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value) {
      const parsed = JSON.parse(value) as Shortcut[]
      if (Array.isArray(parsed)) { return parsed }
    }
  } catch { /* use defaults */ }
  return DEFAULTS
}
const saveShortcuts = (items: Shortcut[]) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)) } catch { /* storage unavailable */ }
}

export function PromptTools({ onInsert, onOpenCanvas }: {
  onInsert: (value: string) => void
  onOpenCanvas: () => void
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Shortcut[]>(readShortcuts)
  const [editing, setEditing] = useState<Shortcut | null>(null)
  const [category, setCategory] = useState('全部')
  const categories = useMemo(() => ['全部', ...Array.from(new Set(items.map(x => x.category)))], [items])
  useEffect(() => saveShortcuts(items), [items])
  const commit = () => {
    if (!editing || !editing.title.trim() || !editing.content) { return }
    setItems(current => current.some(x => x.id === editing.id)
      ? current.map(x => x.id === editing.id ? editing : x)
      : [...current, { ...editing, id: `custom-${Date.now()}` }])
    setEditing(null)
  }
  return <>
    <button type="button" className={styles.toolButton} aria-label="快捷指令库" title="快捷指令库" onClick={() => setOpen(true)}>⌘</button>
    <button type="button" className={styles.toolButton} aria-label="空白画布" title="空白画布" onClick={onOpenCanvas}>▤</button>
    {open ? <div className={styles.backdrop} onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}>
      <section className={styles.panel} role="dialog" aria-modal="true" aria-label="快捷指令库">
        <header className={styles.header}><div><strong>快捷指令库</strong><small>点击片段，插入到当前光标处</small></div><button onClick={() => setOpen(false)}>×</button></header>
        <nav className={styles.categories}>{categories.map(c => <button className={category === c ? styles.active : ''} key={c} onClick={() => setCategory(c)}>{c}</button>)}</nav>
        <div className={styles.list}>{items.filter(x => category === '全部' || x.category === category).map(item =>
          <article className={styles.item} key={item.id}>
            <button className={styles.insert} onClick={() => { onInsert(item.content); setOpen(false) }}><strong>{item.title}</strong><small>{item.category}</small><code>{item.content.slice(0, 100)}</code></button>
            <button className={styles.edit} aria-label={`编辑${item.title}`} onClick={() => setEditing(item)}>✎</button>
            {!DEFAULTS.some(x => x.id === item.id) ? <button className={styles.delete} aria-label={`删除${item.title}`} onClick={() => setItems(v => v.filter(x => x.id !== item.id))}>×</button> : null}
          </article>)}</div>
        <footer className={styles.footer}><span>仅保存在当前浏览器</span><button onClick={() => setEditing({ id: '', title: '', category: '自定义', content: '' })}>＋ 新建指令</button></footer>
        {editing ? <div className={styles.editLayer}><div className={styles.editCard}><strong>{editing.id ? '编辑指令' : '新建指令'}</strong>
          <input value={editing.title} placeholder="名称" onChange={e => setEditing({ ...editing, title: e.target.value })}/>
          <input value={editing.category} placeholder="分类" onChange={e => setEditing({ ...editing, category: e.target.value })}/>
          <textarea value={editing.content} placeholder="要插入的文本或 JS 片段" onChange={e => setEditing({ ...editing, content: e.target.value })}/>
          <div><button onClick={() => setEditing(null)}>取消</button><button onClick={commit}>保存</button></div>
        </div></div> : null}
      </section>
    </div> : null}
  </>
}

export function WritingCanvas({ value, onChange, onClose }: {
  value: string; onChange: (value: string) => void; onClose: () => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <div className={styles.canvas}>
    <header><button onClick={onClose}>‹ 返回</button><strong>空白画布</strong><button className={styles.done} onClick={() => { onChange(draft); onClose() }}>完成并插入</button></header>
    <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} placeholder="在这里自由编辑……" />
    <footer>长文本编辑 · 支持换行、选区与光标移动</footer>
  </div>
}
