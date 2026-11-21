import {
  EXPORT_FORMAT_VERSION,
  type Manifest,
  type SessionIndexEntry,
  type SessionFile,
} from './format.js'
import { INDEX_PATH, MANIFEST_PATH, parseSessionPath, sessionPath } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { ArchiveError, isZipFile, readArchive, readEntry, skipEntry, type ArchiveEntry } from './zipReader.js'
import { writeArchive } from './zipWriter.js'

export type ArchiveImage = { path: string; size: number }
export type ArchiveSession = {
  id: string
  title: string
  updatedAt: string
  size: number
  imageCount: number
  images: ArchiveImage[]
  index: SessionIndexEntry
  json: Blob
}
export type ArchivePackage = {
  id: string
  name: string
  file: File
  sessions: ArchiveSession[]
}
export type SelectedArchiveSession = { packageId: string; sessionId: string }
export type MergeProgress = {
  stage: 'conversations' | 'images' | 'index' | 'packing' | 'done'
  percent: number
  detail: string
}

const parseJson = async (blob: Blob): Promise<unknown> => JSON.parse(await blob.text())
const readBlobWithProgress = async (entry: ArchiveEntry, onChunk: (read: number) => void): Promise<Blob> => {
  const parts: Blob[] = []
  let read = 0
  for await (const chunk of entry.stream) {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
    read += chunk.byteLength
    onChunk(read)
  }
  return new Blob(parts)
}
const fail = (message: string): never => { throw new Error(message) }

/** Validate a v3 archive. Session JSON stays as Blob references; image entries are skipped. */
export const readArchivePackage = async (file: File, id: string): Promise<ArchivePackage> => {
  if (!(await isZipFile(file))) fail('Invalid ZIP file')
  let manifestSeen = false
  let index: SessionIndexEntry[] | null = null
  const sessions = new Map<string, { data: SessionFile; json: Blob; size: number }>()
  const images = new Map<string, ArchiveImage[]>()

  try {
    for await (const entry of readArchive(file)) {
      if (!manifestSeen) {
        if (entry.path !== MANIFEST_PATH) fail('manifest.json must be first')
        checkManifest(await parseJson(await readEntry(entry)))
        manifestSeen = true
        continue
      }
      if (entry.path === INDEX_PATH) {
        if (index) fail('Duplicate session index')
        const raw = await parseJson(await readEntry(entry))
        readSessionIndex(raw)
        if (!Array.isArray(raw)) fail('Invalid session index')
        index = raw as SessionIndexEntry[]
        continue
      }
      if (entry.path === 'user.json') {
        await skipEntry(entry)
        continue
      }
      const sessionId = parseSessionPath(entry.path)
      if (sessionId) {
        if (index || sessions.has(sessionId)) fail('Invalid session entry order')
        const json = await readEntry(entry)
        const data = readSessionFile(await parseJson(json))
        if (data.id !== sessionId) fail('Session ID does not match its path')
        sessions.set(sessionId, { data, json, size: entry.size })
        continue
      }
      const match = /^chat_sessions\/([^/]+)_files\//.exec(entry.path)
      if (match) {
        const list = images.get(match[1]) ?? []
        list.push({ path: entry.path, size: entry.size })
        images.set(match[1], list)
      }
      await skipEntry(entry)
    }
  } catch (error) {
    if (error instanceof ArchiveError) fail('The ZIP archive is damaged or unsupported')
    throw error
  }

  if (!manifestSeen || !index) fail('Missing manifest or session index')
  const indexIds = new Set(index.map((item) => item.id))
  if (indexIds.size !== index.length || index.length !== sessions.size) fail('Index does not match sessions')
  for (const sessionId of sessions.keys()) if (!indexIds.has(sessionId)) fail('Session missing from index')

  const byId = new Map(index.map((item) => [item.id, item]))
  const result: ArchiveSession[] = [...sessions.entries()].map(([sessionId, item]) => {
    const meta = byId.get(sessionId)!
    return {
      id: sessionId,
      title: meta.title ?? item.data.title ?? sessionId,
      updatedAt: meta.updated_at ?? item.data.updated_at,
      size: item.size,
      imageCount: images.get(sessionId)?.length ?? 0,
      images: images.get(sessionId) ?? [],
      index: meta,
      json: item.json,
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return { id, name: file.name, file, sessions: result }
}

const resolveSelected = (
  packages: ArchivePackage[],
  selected: SelectedArchiveSession[],
  preferences: Record<string, string>
): Array<{ pack: ArchivePackage; session: ArchiveSession }> => {
  const packageMap = new Map(packages.map((pack) => [pack.id, pack]))
  const grouped = new Map<string, Array<{ pack: ArchivePackage; session: ArchiveSession }>>()
  for (const item of selected) {
    const pack = packageMap.get(item.packageId)
    const session = pack?.sessions.find((candidate) => candidate.id === item.sessionId)
    if (!pack || !session) continue
    const group = grouped.get(session.id) ?? []
    group.push({ pack, session })
    grouped.set(session.id, group)
  }
  return [...grouped.entries()].map(([sessionId, candidates]) => {
    const preferred = preferences[sessionId]
    if (preferred && preferred !== 'newer') {
      const explicit = candidates.find((candidate) => candidate.pack.id === preferred)
      if (explicit) return explicit
    }
    return candidates.reduce((latest, current) =>
      current.session.updatedAt.localeCompare(latest.session.updatedAt) > 0 ? current : latest
    )
  })
}

/** Build an official v3 ZIP. Only selected images are read; ZIP writing consumes Blob streams. */
export const buildMergedArchive = async (
  packages: ArchivePackage[],
  selected: SelectedArchiveSession[],
  preferences: Record<string, string>,
  omitImages: boolean,
  onProgress: (progress: MergeProgress) => void = () => {}
): Promise<Blob> => {
  const chosen = resolveSelected(packages, selected, preferences)
  if (!chosen.length) fail('Select at least one conversation')

  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const entries: { name: string; blob: Blob }[] = [
    { name: MANIFEST_PATH, blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }) },
  ]
  const index: SessionIndexEntry[] = []
  chosen.forEach(({ session }, position) => {
    entries.push({ name: sessionPath(session.id), blob: session.json })
    index.push(session.index)
    onProgress({
      stage: 'conversations',
      percent: Math.round(((position + 1) / chosen.length) * 24),
      detail: session.title,
    })
  })

  let imageCount = 0
  let imageBytesTotal = 0
  const selectedImagePaths = new Map<string, Set<string>>()
  if (!omitImages) {
    for (const { pack, session } of chosen) {
      if (!session.images.length) continue
      selectedImagePaths.set(\`\${pack.id}\0\${session.id}\`, new Set(session.images.map((image) => image.path)))
      imageCount += session.images.length
      imageBytesTotal += session.images.reduce((sum, image) => sum + image.size, 0)
    }
  }

  let imageBytesDone = 0
  if (imageCount) {
    const byPackage = new Map<string, Array<{ pack: ArchivePackage; session: ArchiveSession }>>()
    for (const item of chosen) {
      if (!selectedImagePaths.has(\`\${item.pack.id}\0\${item.session.id}\`)) continue
      const list = byPackage.get(item.pack.id) ?? []
      list.push(item)
      byPackage.set(item.pack.id, list)
    }
    for (const [packageId, items] of byPackage) {
      const pack = items[0].pack
      const wanted = new Set(items.flatMap(({ session }) => session.images.map((image) => image.path)))
      for await (const entry of readArchive(pack.file)) {
        if (wanted.has(entry.path)) {
          const imageStart = imageBytesDone
          const blob = await readBlobWithProgress(entry, (read) => {
            const percent = imageBytesTotal
              ? 24 + Math.round(((imageStart + read) / imageBytesTotal) * 36)
              : 60
            onProgress({ stage: 'images', percent, detail: entry.path })
          })
          entries.push({ name: entry.path, blob })
          imageBytesDone += entry.size
          wanted.delete(entry.path)
        } else {
          await skipEntry(entry)
        }
      }
      if (wanted.size) fail('A selected image is missing from its ZIP package')
    }
  }

  onProgress({ stage: 'index', percent: 64, detail: String(index.length) })
  entries.splice(1 + chosen.length, 0, {
    name: INDEX_PATH,
    blob: new Blob([JSON.stringify(index)], { type: 'application/json' }),
  })
  onProgress({ stage: 'packing', percent: 85, detail: String(entries.length) })
  const blob = await writeArchive(entries)
  onProgress({ stage: 'done', percent: 100, detail: String(blob.size) })
  return blob
}

export const sanitizeArchiveName = (value: string, fallback: string): string => {
  const clean = (value || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return \`\${clean || 'DeepSeek 对话'}.zip\`.replace(/\.zip\.zip$/i, '.zip')
}
