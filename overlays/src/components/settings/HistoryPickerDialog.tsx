import { useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { exportHistory } from '../../services/chat/backup.js'
import {
  buildMergedArchive,
  readArchivePackage,
  sanitizeArchiveName,
  type ArchivePackage,
  type ArchiveSession,
  type MergeProgress,
  type SelectedArchiveSession,
} from '../../services/chat/history/mergeArchive.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import styles from './HistoryPickerDialog.module.css'

type Mode = 'pick' | 'merge'
type Props = { open: boolean; historyBusy: boolean; onClose: () => void; onReplace: (file: File) => void }
const keyOf = (packageId: string, sessionId: string) => `${packageId}::${sessionId}`
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const formatDate = (value: string) => value ? value.slice(0, 16).replace('T', ' ') : ''
const progressLabels = {
  conversations: 'historyPickerProgressConversations',
  images: 'historyPickerProgressImages',
  index: 'historyPickerProgressIndex',
  packing: 'historyPickerProgressPacking',
  done: 'historyPickerProgressDone',
} as const

const SessionRow = ({
  pack, session, selected, duplicate, onToggle,
}: {
  pack: ArchivePackage
  session: ArchiveSession
  selected: boolean
  duplicate: boolean
  onToggle: (checked: boolean) => void
}) => {
  const t = useTranslate()
  const [preview, setPreview] = useState('')
  const [loaded, setLoaded] = useState(false)
  const loadPreview = async () => {
    if (loaded) { return }
    setLoaded(true)
    try {
      const source = await session.json.text()
      let formatted = source
      try { formatted = JSON.stringify(JSON.parse(source), null, 2) } catch { /* Keep source text. */ }
      setPreview(formatted.length > 30000 ? `${formatted.slice(0, 30000)}\n${t('historyPickerPreviewTruncated')}` : formatted)
    } catch {
      setPreview(t('historyPickerPreviewFailed'))
    }
  }
  return (
    <div className={styles.sessionRow}>
      <input className={styles.checkbox} type="checkbox" checked={selected} aria-label={session.title} onChange={(event) => onToggle(event.target.checked)} />
      <details className={styles.sessionDetails} onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) { void loadPreview() }
      }}>
        <summary className={styles.sessionSummary}>
          <span className={styles.sessionTitle}>{session.title}</span>
          <span className={styles.sessionMeta}>
            {formatDate(session.updatedAt)} · {formatSize(session.size)} · {t('historyPickerImageCount', { count: session.imageCount })}
            {duplicate ? ` · ${t('historyPickerDuplicateMark')}` : ''}
          </span>
        </summary>
        <pre className={styles.preview}>{loaded ? preview : t('historyPickerPreviewLoading')}</pre>
      </details>
      <span className={styles.packageName}>{pack.name}</span>
    </div>
  )
}

export const HistoryPickerDialog = ({ open, historyBusy, onClose, onReplace }: Props) => {
  const t = useTranslate()
  const pickInput = useRef<HTMLInputElement>(null)
  const mergeInput = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<Mode>('pick')
  const [pickPackages, setPickPackages] = useState<ArchivePackage[]>([])
  const [mergePackages, setMergePackages] = useState<ArchivePackage[]>([])
  const [selection, setSelection] = useState<Record<string, boolean>>({})
  const [preferences, setPreferences] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [filename, setFilename] = useState('')
  const [omitImages, setOmitImages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState<MergeProgress | null>(null)
  const [generated, setGenerated] = useState<File | null>(null)
  const packages = mode === 'pick' ? pickPackages : mergePackages
  const allSessions = useMemo(() => packages.flatMap((pack) => pack.sessions.map((session) => ({ pack, session }))), [packages])
  const selected = useMemo(() => allSessions.filter(({ pack, session }) => selection[keyOf(pack.id, session.id)]), [allSessions, selection])
  const duplicateGroups = useMemo(() => {
    const groups = new Map<string, Array<{ pack: ArchivePackage; session: ArchiveSession }>>()
    for (const item of allSessions) {
      const group = groups.get(item.session.id) ?? []
      group.push(item)
      groups.set(item.session.id, group)
    }
    return [...groups.entries()].filter(([, group]) => group.length > 1)
  }, [allSessions])
  const filtered = (session: ArchiveSession) => !query.trim() || session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const chosen = useMemo(() => {
    const groups = new Map<string, Array<{ pack: ArchivePackage; session: ArchiveSession }>>()
    for (const item of selected) {
      const group = groups.get(item.session.id) ?? []
      group.push(item)
      groups.set(item.session.id, group)
    }
    return [...groups.entries()].map(([id, candidates]) => {
      const preferred = preferences[id]
      const explicit = preferred && preferred !== 'newer' ? candidates.find((item) => item.pack.id === preferred) : undefined
      return explicit ?? candidates.reduce((latest, current) => current.session.updatedAt.localeCompare(latest.session.updatedAt) > 0 ? current : latest)
    })
  }, [selected, preferences])
  const mergeNeedsMore = mode === 'merge' && mergePackages.length < 2
  const canBuild = chosen.length > 0 && !mergeNeedsMore && !busy
  const autoName = chosen.length === 0 ? '' : chosen.length === 1 ? chosen[0].session.title : `${chosen[0].session.title}等${chosen.length}个`

  const loadFiles = async (files: File[], append: boolean) => {
    if (!files.length || busy) { return }
    setBusy(true)
    setStatus(t('historyPickerReading'))
    setGenerated(null)
    try {
      const current = mode === 'pick' ? pickPackages : mergePackages
      const added: ArchivePackage[] = []
      for (const file of files) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        added.push(await readArchivePackage(file, id))
      }
      const next = append ? [...current, ...added] : added.slice(0, 1)
      if (mode === 'pick') { setPickPackages(next) }
      else { setMergePackages(next) }
      if (!append) { setSelection({}) }
      setPreferences({})
      setStatus(t('historyPickerLoaded', { packages: next.length, sessions: next.reduce((sum, pack) => sum + pack.sessions.length, 0) }))
    } catch {
      setStatus(t('historyPickerReadFailed'))
    } finally {
      setBusy(false)
    }
  }

  const addLocalHistory = async () => {
    if (busy || historyBusy) { return }
    setBusy(true)
    setStatus(t('historyPickerExportingLocal'))
    try {
      const { name, blob } = await exportHistory()
      const file = new File([blob], name, { type: 'application/zip' })
      const pack = await readArchivePackage(file, `local-${Date.now()}`)
      setMergePackages((current) => [...current, pack])
      setStatus(t('historyPickerLocalAdded', { count: pack.sessions.length }))
    } catch {
      setStatus(t('historyPickerReadFailed'))
    } finally {
      setBusy(false)
    }
  }

  const setPackageSelection = (pack: ArchivePackage, checked: boolean) => {
    setSelection((current) => {
      const next = { ...current }
      for (const session of pack.sessions) { next[keyOf(pack.id, session.id)] = checked }
      return next
    })
    setGenerated(null)
  }
  const setOneSelection = (pack: ArchivePackage, session: ArchiveSession, checked: boolean) => {
    setSelection((current) => ({ ...current, [keyOf(pack.id, session.id)]: checked }))
    setGenerated(null)
  }
  const selectFiltered = (action: 'all' | 'none' | 'invert') => {
    setSelection((current) => {
      const next = { ...current }
      for (const { pack, session } of allSessions) {
        if (!filtered(session)) { continue }
        const key = keyOf(pack.id, session.id)
        next[key] = action === 'all' ? true : action === 'none' ? false : !current[key]
      }
      return next
    })
    setGenerated(null)
  }

  const build = async () => {
    if (!canBuild) { return }
    setBusy(true)
    setGenerated(null)
    setProgress({ stage: 'conversations', percent: 0, detail: '' })
    try {
      const selectedItems: SelectedArchiveSession[] = selected.map(({ pack, session }) => ({ packageId: pack.id, sessionId: session.id }))
      const blob = await buildMergedArchive(packages, selectedItems, preferences, omitImages, setProgress)
      const file = new File([blob], sanitizeArchiveName(filename, autoName), { type: 'application/zip' })
      setGenerated(file)
      setStatus(t('historyPickerGenerated', { size: formatSize(file.size) }))
    } catch {
      setStatus(t('historyPickerBuildFailed'))
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    if (!generated) { return }
    const url = URL.createObjectURL(generated)
    const link = document.createElement('a')
    link.href = url
    link.download = generated.name
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  const changeMode = (next: Mode) => {
    setMode(next)
    setQuery('')
    setGenerated(null)
    setStatus('')
    setProgress(null)
  }
  if (!open) { return null }

  return (
    <Modal title={t('historyPickerTitle')} className={styles.dialog} mainClassName={styles.main} onClose={() => { if (!busy) { onClose() } }}>
      <div className={styles.intro}>{t('historyPickerIntro')}</div>
      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'pick'} className={mode === 'pick' ? styles.activeTab : ''} onClick={() => changeMode('pick')}>{t('historyPickerPickTab')}</button>
        <button type="button" role="tab" aria-selected={mode === 'merge'} className={mode === 'merge' ? styles.activeTab : ''} onClick={() => changeMode('merge')}>{t('historyPickerMergeTab')}</button>
      </div>
      <div className={styles.toolbar}>
        {mode === 'pick' ? (
          <>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => pickInput.current?.click()}>{t('historyPickerChooseZip')}</Button>
            <Button variant="outlined" size="m" disabled={busy || pickPackages.length === 0} onClick={() => mergeInput.current?.click()}>{t('historyPickerAddCompareZip')}</Button>
            <input ref={pickInput} hidden type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { void loadFiles([file], false) } }} />
            <input ref={mergeInput} hidden type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { void loadFiles([file], true) } }} />
          </>
        ) : (
          <>
            <Button variant="outlined" size="m" disabled={busy} onClick={() => mergeInput.current?.click()}>{t('historyPickerAddZip')}</Button>
            <Button variant="outlined" size="m" disabled={busy || historyBusy} onClick={() => void addLocalHistory()}>{t('historyPickerAddLocal')}</Button>
            <input ref={mergeInput} hidden type="file" multiple accept=".zip,application/zip" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void loadFiles(files, true) }} />
          </>
        )}
      </div>
      <div className={styles.status} role="status">{status || (mode === 'pick' ? t('historyPickerPickHint') : t('historyPickerMergeHint'))}</div>

      {packages.length > 0 ? (
        <>
          <input className={styles.search} type="search" value={query} placeholder={t('historyPickerSearch')} onChange={(event) => setQuery(event.target.value)} />
          <div className={styles.selectionBar}>
            <Button variant="outlined" size="s" disabled={busy} onClick={() => selectFiltered('all')}>{t('historyPickerSelectAll')}</Button>
            <Button variant="outlined" size="s" disabled={busy} onClick={() => selectFiltered('none')}>{t('historyPickerSelectNone')}</Button>
            <Button variant="outlined" size="s" disabled={busy} onClick={() => selectFiltered('invert')}>{t('historyPickerInvert')}</Button>
            <span>{t('historyPickerSelectedCount', { selected: selected.length, total: allSessions.length, unique: chosen.length })}</span>
          </div>
          <div className={styles.list}>
            {packages.map((pack) => (
              <details className={styles.package} key={pack.id} open>
                <summary>{pack.name}<span className={styles.packageCount}>{t('historyPickerPackageCount', { count: pack.sessions.length, selected: pack.sessions.filter((session) => selection[keyOf(pack.id, session.id)]).length })}</span></summary>
                {mode === 'merge' ? (
                  <div className={styles.packageActions}>
                    <Button variant="outlined" size="s" onClick={() => setPackageSelection(pack, true)}>{t('historyPickerSelectPackage')}</Button>
                    <Button variant="outlined" size="s" onClick={() => setPackageSelection(pack, false)}>{t('historyPickerClearPackage')}</Button>
                    <Button variant="outlined" size="s" onClick={() => { setMergePackages((current) => current.filter((item) => item.id !== pack.id)); setSelection((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${pack.id}::`)))); setGenerated(null) }}>{t('historyPickerRemovePackage')}</Button>
                  </div>
                ) : null}
                {pack.sessions.filter(filtered).map((session) => (
                  <SessionRow
                    key={session.id}
                    pack={pack}
                    session={session}
                    selected={!!selection[keyOf(pack.id, session.id)]}
                    duplicate={packages.filter((candidate) => candidate.sessions.some((item) => item.id === session.id)).length > 1}
                    onToggle={(checked) => setOneSelection(pack, session, checked)}
                  />
                ))}
              </details>
            ))}
          </div>
          {duplicateGroups.length ? (
            <section className={styles.duplicates}>
              <div className={styles.sectionTitle}>{t('historyPickerDuplicates', { count: duplicateGroups.length })}</div>
              <div className={styles.muted}>{t('historyPickerDuplicateHint')}</div>
              {duplicateGroups.map(([id, group]) => {
                const newest = group.reduce((latest, item) => item.session.updatedAt.localeCompare(latest.session.updatedAt) > 0 ? item : latest)
                const options = [{ value: 'newer', label: t('historyPickerUseNewer') }, ...group.map(({ pack }) => ({ value: pack.id, label: t('historyPickerUsePackage', { name: pack.name }) }))]
                return (
                  <div className={styles.duplicateRow} key={id}>
                    <div className={styles.duplicateTitle}>{group[0].session.title}</div>
                    <div className={styles.muted}>{group.map(({ pack, session }) => `${pack.name}: ${formatDate(session.updatedAt)} · ${formatSize(session.size)}${session === newest.session ? ` · ${t('historyPickerNewest')}` : ''}`).join('\n')}</div>
                    <Select value={preferences[id] ?? 'newer'} options={options} onChange={(value) => {
                      setPreferences((current) => ({ ...current, [id]: value }))
                      if (value !== 'newer') {
                        const selectedPackage = group.find((item) => item.pack.id === value)
                        if (selectedPackage) {
                          setSelection((current) => ({ ...current, [keyOf(selectedPackage.pack.id, id)]: true }))
                        }
                      }
                      setGenerated(null)
                    }} ariaLabel={t('historyPickerDuplicateChoice')} />
                  </div>
                )
              })}
            </section>
          ) : null}
          <section className={styles.output}>
            <label className={styles.fieldLabel} htmlFor="history-picker-filename">{t('historyPickerFilename')}</label>
            <input id="history-picker-filename" className={styles.search} value={filename} placeholder={autoName || t('historyPickerAutoName')} onChange={(event) => setFilename(event.target.value)} />
            <label className={styles.checkboxLabel}>
              <input type="checkbox" checked={omitImages} onChange={(event) => { setOmitImages(event.target.checked); setGenerated(null) }} />
              {t('historyPickerOmitImages')}
            </label>
            <Button block disabled={!canBuild} onClick={() => void build()}>{busy ? t('historyPickerBuilding') : t('historyPickerBuild')}</Button>
            {mergeNeedsMore ? <div className={styles.muted}>{t('historyPickerNeedTwoPackages')}</div> : null}
            {progress ? (
              <>
                <div className={styles.progressTrack}><div className={styles.progressFill} style={{ width: `${progress.percent}%` }} /></div>
                <div className={styles.progressLabel}>{t(progressLabels[progress.stage])} · {progress.percent}%</div>
              </>
            ) : null}
            <div className={styles.muted}>{t('historyPickerReplaceWarning')}</div>
            {generated ? (
              <div className={styles.resultActions}>
                <Button variant="outlined" size="m" onClick={download}>{t('historyPickerDownload')}</Button>
                <Button variant="outlined" size="m" disabled={historyBusy || busy} onClick={() => onReplace(generated)}>{t('historyPickerReplaceLocal')}</Button>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </Modal>
  )
}
