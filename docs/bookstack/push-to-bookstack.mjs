#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Publie la documentation Obliguard dans BookStack (étagère ObliTools) via l'API.
//
// Idempotent : ré-exécutable sans créer de doublons. Fait correspondre l'étagère,
// le livre, les chapitres et les pages PAR NOM ; crée ce qui manque, met à jour
// le reste (titres, contenus Markdown, ordre).
//
// Prérequis : Node 18+ (fetch global). Aucune dépendance externe.
//
// Variables d'environnement requises (un jeton d'API BookStack avec droits
// d'écriture — profil utilisateur BookStack → « Jetons d'API ») :
//   BOOKSTACK_URL           ex. https://wiki.mondomaine.fr   (sans /api)
//   BOOKSTACK_TOKEN_ID      l'identifiant du jeton
//   BOOKSTACK_TOKEN_SECRET  le secret du jeton
//
// Utilisation :
//   node push-to-bookstack.mjs            # publie / met à jour
//   node push-to-bookstack.mjs --dry-run  # simulation (aucune écriture)
//
// PowerShell :
//   $env:BOOKSTACK_URL='https://wiki.exemple.fr'
//   $env:BOOKSTACK_TOKEN_ID='xxxx'; $env:BOOKSTACK_TOKEN_SECRET='yyyy'
//   node .\push-to-bookstack.mjs
// bash :
//   BOOKSTACK_URL=... BOOKSTACK_TOKEN_ID=... BOOKSTACK_TOKEN_SECRET=... node push-to-bookstack.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BASE = (process.env.BOOKSTACK_URL || process.env.BS_URL || '').replace(/\/+$/, '')
const TOKEN_ID = process.env.BOOKSTACK_TOKEN_ID || process.env.BS_TOKEN_ID || ''
const TOKEN_SECRET = process.env.BOOKSTACK_TOKEN_SECRET || process.env.BS_TOKEN_SECRET || ''
const DRY = process.argv.includes('--dry-run')

if (!BASE || !TOKEN_ID || !TOKEN_SECRET) {
  console.error('❌ Variables requises manquantes.')
  console.error('   Définis BOOKSTACK_URL, BOOKSTACK_TOKEN_ID et BOOKSTACK_TOKEN_SECRET, puis relance.')
  process.exit(1)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const headers = {
  Authorization: `Token ${TOKEN_ID}:${TOKEN_SECRET}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
}

async function api(method, endpoint, body) {
  const res = await fetch(`${BASE}/api${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`${method} /api${endpoint} → ${res.status} ${res.statusText}\n${JSON.stringify(json, null, 2)}`)
  }
  return json
}

/** Mutation, court-circuitée en simulation (--dry-run). */
async function mutate(method, endpoint, body, label) {
  if (DRY) {
    console.log(`   [dry-run] ${method} ${endpoint}${label ? ' — ' + label : ''}`)
    return { id: `dry-${Math.round(Math.random() * 1e9)}`, ...body }
  }
  return api(method, endpoint, body)
}

/** Récupère TOUS les éléments d'un endpoint de liste (pagination BookStack). */
async function listAll(endpoint) {
  const out = []
  let offset = 0
  const count = 200
  for (;;) {
    const sep = endpoint.includes('?') ? '&' : '?'
    const page = await api('GET', `${endpoint}${sep}count=${count}&offset=${offset}`)
    const data = page.data || []
    out.push(...data)
    const total = typeof page.total === 'number' ? page.total : out.length
    if (data.length < count || out.length >= total) break
    offset += count
  }
  return out
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(scriptDir, 'manifest.json'), 'utf-8'))
  console.log(`→ Cible BookStack : ${BASE}${DRY ? '   (SIMULATION)' : ''}`)

  // ── 1. Livre (upsert par nom) ──────────────────────────────────────────────
  const books = await listAll('/books')
  let book = books.find((b) => b.name === manifest.book.name)
  if (!book) {
    book = await mutate('POST', '/books', { name: manifest.book.name, description: manifest.book.description }, 'livre')
    console.log(`📘 Livre créé : « ${manifest.book.name} » (#${book.id})`)
  } else {
    await mutate('PUT', `/books/${book.id}`, { name: manifest.book.name, description: manifest.book.description }, 'livre')
    console.log(`📘 Livre existant : « ${manifest.book.name} » (#${book.id})`)
  }

  // ── 2. Chapitres + pages (upsert par nom, dans le livre) ───────────────────
  const existingChapters = (await listAll('/chapters')).filter((c) => c.book_id === book.id)
  const existingPages = (await listAll('/pages')).filter((p) => p.book_id === book.id)
  let created = 0
  let updated = 0

  for (const ch of manifest.chapters) {
    let chapter = existingChapters.find((c) => c.name === ch.name)
    if (!chapter) {
      chapter = await mutate('POST', '/chapters', { book_id: book.id, name: ch.name, priority: ch.priority }, 'chapitre')
      console.log(`  📂 Chapitre créé : ${ch.name}`)
    } else {
      await mutate('PUT', `/chapters/${chapter.id}`, { name: ch.name, priority: ch.priority }, 'chapitre')
    }

    for (const pg of ch.pages) {
      const md = await readFile(path.join(scriptDir, 'Obliguard', pg.file), 'utf-8')
      const existing = existingPages.find((p) => p.chapter_id === chapter.id && p.name === pg.name)
      if (!existing) {
        await mutate('POST', '/pages', { chapter_id: chapter.id, name: pg.name, markdown: md, priority: pg.priority }, 'page')
        created++
        console.log(`    📄 Page créée : ${pg.name}`)
      } else {
        await mutate('PUT', `/pages/${existing.id}`, { name: pg.name, markdown: md, priority: pg.priority }, 'page')
        updated++
      }
    }
  }

  // ── 3. Étagère (upsert par nom) + rattachement du livre ────────────────────
  const shelves = await listAll('/shelves')
  let shelf = shelves.find((s) => s.name === manifest.shelf.name)
  if (!shelf) {
    shelf = await mutate('POST', '/shelves', { name: manifest.shelf.name, description: manifest.shelf.description, books: [book.id] }, 'étagère')
    console.log(`📚 Étagère créée : « ${manifest.shelf.name} » (livre rattaché)`)
  } else {
    let bookIds = [book.id]
    if (!DRY) {
      const detail = await api('GET', `/shelves/${shelf.id}`)
      bookIds = [...new Set([...(detail.books || []).map((b) => b.id), book.id])]
    }
    await mutate('PUT', `/shelves/${shelf.id}`, { name: manifest.shelf.name, description: manifest.shelf.description, books: bookIds }, 'étagère')
    console.log(`📚 Étagère existante : « ${manifest.shelf.name} » (livre rattaché)`)
  }

  console.log(`\n✅ Terminé. Pages créées : ${created}, mises à jour : ${updated}.`)
  if (DRY) console.log('   (Simulation — aucune écriture réelle n\'a été effectuée.)')
  else console.log(`   Ouvre ${BASE} pour vérifier l'étagère « ${manifest.shelf.name} ».`)
}

main().catch((err) => {
  console.error('\n❌ Échec de la publication :')
  console.error(err.message)
  process.exit(1)
})
