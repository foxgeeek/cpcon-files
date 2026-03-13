const express    = require("express")
const multer     = require("multer")
const path       = require("path")
const fs         = require("fs")
const AdmZip     = require("adm-zip")
const { execFile } = require("child_process")
const { promisify } = require("util")
const { v4: uuidv4 } = require("uuid")
const sharp      = require("sharp")

const execFileAsync = promisify(execFile)
const GS_TIMEOUT_MS = 300_000 // 5min máximo para ghostscript (PDFs grandes)

// Sanitiza um path relativo de subfolder contra path traversal
function safeSub(p) {
  if (!p) return null
  const parts = String(p).split("/").map(s => path.basename(s)).filter(s => s && s !== ".")
  return parts.length ? parts.join("/") : null
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // remove acentos
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/_+/g, "_")
    .substring(0, 80)
}

const app        = express()
const PORT       = process.env.PORT || 80
const API_KEY    = process.env.API_KEY || "change-me"
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/uploads"
const BASE_URL   = process.env.BASE_URL || ("http://localhost:" + PORT)

const IMAGE_MAX_BYTES = 5  * 1024 * 1024 // 5MB  — limite final de imagens
const PDF_MAX_BYTES   = 20 * 1024 * 1024 // 20MB — limite final de PDFs
const OTHER_MAX_BYTES = 20 * 1024 * 1024 // 20MB — outros tipos
const IMAGE_EXTS      = [".jpg", ".jpeg", ".png", ".webp", ".avif"]
const ALLOWED_FOLDERS = ["imagens", "material-apoio", "qrcodes", "questoes", "redacoes", "simulados", "videos"]

// Garante diretórios no boot
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  ALLOWED_FOLDERS.forEach((f) => fs.mkdirSync(path.join(UPLOAD_DIR, f), { recursive: true }))
  console.log("Diretórios prontos em:", UPLOAD_DIR)
} catch (err) {
  console.error("ERRO ao criar diretórios:", err.message)
}

// Auth
function auth(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" })
  next()
}

// Multer — aceita até 50MB antes de comprimir
const storage = multer.diskStorage({
  destination: (req, _, cb) => {
    const folder = req.query.folder
    if (!folder || !ALLOWED_FOLDERS.includes(folder))
      return cb(new Error("Pasta inválida. Use: " + ALLOWED_FOLDERS.join(", ")))
    const subfolder = safeSub(req.query.subfolder)
    const dest = subfolder
      ? path.join(UPLOAD_DIR, folder, subfolder)
      : path.join(UPLOAD_DIR, folder)
    try { fs.mkdirSync(dest, { recursive: true }) } catch (e) { return cb(e) }
    cb(null, dest)
  },
  filename: (req, file, cb) => {
    const origExt = path.extname(file.originalname)          // extensão original (pode ser .JPG, .PDF…)
    const ext     = origExt.toLowerCase()                    // extensão final normalizada
    const base    = path.basename(file.originalname, origExt) // remove extensão com case original
    const slug    = slugify(base)

    const idCurso      = req.query.id_curso
    const idDisciplina = req.query.id_disciplina
    const idProfessor  = req.query.id_professor
    const subfolder    = req.query.subfolder

    const filename = (idCurso && idDisciplina && idProfessor)
      ? `${idCurso}-${idDisciplina}-${idProfessor}-${slug}${ext}`
      : subfolder
        ? `${slug}${ext}`   // usa o originalname quando vai pra subpasta
        : uuidv4() + ext    // fallback UUID

    cb(null, filename)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
})

// Upload sem limite — apenas para admin (extração de zip, backup, etc.)
// Mantém o nome original do arquivo
const storageRaw = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder    = req.query.folder || "uploads"
    const subfolder = safeSub(req.query.subfolder)
    const dest      = subfolder ? path.join(FILES_DIR, folder, subfolder) : path.join(FILES_DIR, folder)
    fs.mkdirSync(dest, { recursive: true })
    cb(null, dest)
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname)
  },
})
const uploadRaw = multer({
  storage: storageRaw,
  limits: { fileSize: Infinity },
})

// --- Compressão de imagem com sharp ---
// Sempre comprime. Se ficar abaixo de IMAGE_MAX_BYTES numa das passagens, para cedo.
// Caso contrário, usa a menor versão obtida e aceita assim mesmo.
async function compressImage(filepath) {
  const ext    = path.extname(filepath).toLowerCase()
  const format = ext === ".png" ? "png" : "jpeg"
  const tmp    = filepath + ".tmp"

  const passes = [
    { width: 1920, quality: 80 },
    { width: 1920, quality: 65 },
    { width: 1920, quality: 50 },
    { width: 1200, quality: 40 },
    { width: 800,  quality: 35 },
  ]

  let bestSize = Infinity
  let bestTmp  = null

  for (const { width, quality } of passes) {
    const out = filepath + `.q${quality}.tmp`
    await sharp(filepath)
      .resize({ width, withoutEnlargement: true })
      .toFormat(format, { quality })
      .toFile(out)

    const size = fs.statSync(out).size

    // Guarda a menor versão obtida até agora
    if (size < bestSize) {
      if (bestTmp && fs.existsSync(bestTmp)) fs.unlinkSync(bestTmp)
      bestSize = size
      bestTmp  = out
    } else {
      fs.unlinkSync(out)
    }

    // Para cedo se já está dentro do limite ideal
    if (size <= IMAGE_MAX_BYTES) break
  }

  // Usa a melhor versão comprimida (mesmo que fique acima do limite)
  if (bestTmp) {
    fs.renameSync(bestTmp, filepath)
  }

  // Limpa qualquer tmp restante
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp)

  return fs.statSync(filepath).size
}

// --- Compressão de PDF com ghostscript (passagem única) ---
async function compressPdf(filepath) {
  const originalSize = fs.statSync(filepath).size
  const tmp = filepath + ".tmp.pdf"

  try {
    // Passagem única: reduz resolução de imagens internas para 150dpi
    // Não usa presets (/ebook, /screen) — flags diretas são mais previsíveis e rápidas
    await execFileAsync("gs", [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dNOPAUSE",
      "-dBATCH",
      "-dDetectDuplicateImages=true",
      "-dDownsampleColorImages=true",
      "-dColorImageResolution=150",
      "-dDownsampleGrayImages=true",
      "-dGrayImageResolution=150",
      "-dDownsampleMonoImages=true",
      "-dMonoImageResolution=150",
      "-sOutputFile=" + tmp,
      filepath,
    ], { timeout: GS_TIMEOUT_MS })
  } catch (err) {
    console.warn("[compress] gs falhou, usando arquivo original:", err.message)
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    return originalSize  // fallback: sobe o original sem comprimir
  }

  const compressedSize = fs.existsSync(tmp) ? fs.statSync(tmp).size : originalSize

  // Usa o comprimido se for menor; descarta se ficar maior (raro)
  if (compressedSize < originalSize) {
    fs.renameSync(tmp, filepath)
  } else {
    fs.unlinkSync(tmp)
  }

  const finalSize = fs.statSync(filepath).size
  if (finalSize > PDF_MAX_BYTES) {
    fs.unlinkSync(filepath)
    throw new Error("PDF muito grande (" + (finalSize / 1024 / 1024).toFixed(1) + "MB). Máximo: 20MB")
  }

  return finalSize
}

// --- Dispatcher de compressão ---
async function compress(filepath) {
  const ext  = path.extname(filepath).toLowerCase()
  const size = fs.statSync(filepath).size

  if (IMAGE_EXTS.includes(ext)) {
    const final = await compressImage(filepath)
    console.log("[compress] imagem:", (size / 1024).toFixed(0) + "KB →", (final / 1024).toFixed(0) + "KB")
    return final
  }

  if (ext === ".pdf") {
    const final = await compressPdf(filepath)
    console.log("[compress] pdf:", (size / 1024).toFixed(0) + "KB →", (final / 1024).toFixed(0) + "KB")
    return final
  }

  // Outros tipos: valida limite
  if (size > OTHER_MAX_BYTES) {
    fs.unlinkSync(filepath)
    throw new Error("Arquivo muito grande (" + (size / 1024 / 1024).toFixed(1) + "MB). Máximo: 20MB")
  }

  return size
}

// POST /upload?folder=material-apoio
app.post("/upload", auth, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      console.error("[upload] multer error:", err.message)
      return res.status(400).json({ error: err.message })
    }
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" })

    try {
      const finalSize = await compress(req.file.path)
      const folder    = req.query.folder
      const subfolder = safeSub(req.query.subfolder)
      const url       = subfolder
        ? BASE_URL + "/files/" + folder + "/" + subfolder + "/" + req.file.filename
        : BASE_URL + "/files/" + folder + "/" + req.file.filename

      console.log("[upload] OK:", folder + "/" + req.file.filename, "(" + (finalSize / 1024).toFixed(0) + "KB)")

      res.json({
        url,
        folder,
        filename:     req.file.filename,
        originalname: req.file.originalname,
        size:         finalSize,
        mimetype:     req.file.mimetype,
      })
    } catch (e) {
      console.error("[upload] error:", e.message)
      res.status(400).json({ error: e.message })
    }
  })
})

// POST /upload-raw?folder=X — upload sem compressão e sem limite (admin/extract)
app.post("/upload-raw", auth, (req, res) => {
  uploadRaw.single("file")(req, res, async (err) => {
    if (err) {
      console.error("[upload-raw] multer error:", err.message)
      return res.status(400).json({ error: err.message })
    }
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" })

    const folder    = req.query.folder
    const subfolder = safeSub(req.query.subfolder)
    const finalSize = fs.statSync(req.file.path).size
    const url       = subfolder
      ? BASE_URL + "/files/" + folder + "/" + subfolder + "/" + req.file.filename
      : BASE_URL + "/files/" + folder + "/" + req.file.filename

    console.log("[upload-raw] OK:", folder + "/" + req.file.filename, "(" + (finalSize / 1024).toFixed(0) + "KB)")

    res.json({
      url,
      folder,
      filename:     req.file.filename,
      originalname: req.file.originalname,
      size:         finalSize,
      mimetype:     req.file.mimetype,
    })
  })
})

// POST /extract-zip?folder=X&subfolder=Y&filename=Z — extrai zip que já está no disco
app.post("/extract-zip", auth, express.json(), (req, res) => {
  const folder    = req.query.folder || req.body.folder
  const subfolder = safeSub(req.query.subfolder || req.body.subfolder)
  const filename  = req.query.filename || req.body.filename

  if (!folder || !ALLOWED_FOLDERS.includes(folder))
    return res.status(400).json({ error: "Pasta inválida" })
  if (!filename || !filename.toLowerCase().endsWith(".zip"))
    return res.status(400).json({ error: "filename deve ser um .zip" })

  const dir = subfolder
    ? path.join(UPLOAD_DIR, folder, subfolder)
    : path.join(UPLOAD_DIR, folder)
  const zipPath = path.join(dir, path.basename(filename))

  if (!fs.existsSync(zipPath))
    return res.status(404).json({ error: "Arquivo zip não encontrado" })

  let zip
  try {
    zip = new AdmZip(zipPath)
  } catch (err) {
    return res.status(400).json({ error: "Arquivo zip inválido ou corrompido" })
  }

  const entries = zip.getEntries()
  const extracted = []
  const errors = []

  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (entry.entryName.startsWith("__MACOSX/")) continue
    if (entry.entryName.includes("/.")) continue

    const data = entry.getData()
    if (!data || data.length === 0) continue

    const entryParts = entry.entryName.split("/")
    const entryFilename = entryParts.pop()
    const entrySubdir = entryParts.join("/")

    // Destino: mesma pasta do zip + estrutura interna do zip
    let targetDir = dir
    if (entrySubdir) {
      targetDir = path.join(dir, entrySubdir)
      try { fs.mkdirSync(targetDir, { recursive: true }) } catch {}
    }

    const targetPath = path.join(targetDir, entryFilename)
    try {
      fs.writeFileSync(targetPath, data)
      extracted.push(entry.entryName)
    } catch (err) {
      errors.push(entry.entryName)
    }
  }

  console.log(`[extract-zip] OK: ${extracted.length} extraídos, ${errors.length} erros de ${zipPath}`)

  res.json({
    success: true,
    extracted: extracted.length,
    errors: errors.length,
    files: extracted,
  })
})

// GET /files — serve arquivos publicamente
app.use("/files", express.static(UPLOAD_DIR, {
  setHeaders: (res) => res.set("Cache-Control", "public, max-age=31536000"),
}))

// GET /list/:folder?subfolder= — lista arquivos/subpastas com metadados (requer auth)
app.get("/list/:folder", auth, (req, res) => {
  const folder = req.params.folder
  if (!ALLOWED_FOLDERS.includes(folder))
    return res.status(400).json({ error: "Pasta inválida" })

  const subfolder = safeSub(req.query.subfolder)
  const dir = subfolder
    ? path.join(UPLOAD_DIR, folder, subfolder)
    : path.join(UPLOAD_DIR, folder)

  if (!fs.existsSync(dir)) return res.json({ folder, subfolder: subfolder || null, entries: [] })

  const raw = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith("."))
  const entries = raw.map(e => {
    const stat = fs.statSync(path.join(dir, e.name))
    return {
      name:     e.name,
      isDir:    e.isDirectory(),
      size:     e.isFile() ? stat.size : null,
      modified: stat.mtime.toISOString(),
    }
  }).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  res.json({ folder, subfolder: subfolder || null, entries })
})

// DELETE /files/* — suporta qualquer profundidade (folder/file ou folder/subfolder/file)
app.delete("/files/*", auth, (req, res) => {
  const filePath = req.params[0]
  const parts    = filePath.split("/").filter(Boolean)

  if (parts.length < 2)
    return res.status(400).json({ error: "Caminho inválido. Use: pasta/arquivo ou pasta/subpasta/arquivo" })

  const folder = parts[0]
  if (!ALLOWED_FOLDERS.includes(folder))
    return res.status(400).json({ error: "Pasta inválida" })

  // Sanitiza cada segmento contra path traversal
  const safeParts = parts.map(p => path.basename(p))
  const filepath  = path.join(UPLOAD_DIR, ...safeParts)

  if (!fs.existsSync(filepath))
    return res.status(404).json({ error: "Arquivo não encontrado" })

  try {
    const stat = fs.statSync(filepath)
    if (stat.isDirectory()) {
      fs.rmSync(filepath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(filepath)
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /move?from=folder/sub/file&to=folder2/sub2/file — move (rename) arquivo ou pasta
app.post("/move", auth, (req, res) => {
  const from = req.query.from
  const to   = req.query.to

  if (!from || !to)
    return res.status(400).json({ error: "from e to são obrigatórios" })

  const fromParts = String(from).split("/").filter(Boolean)
  const toParts   = String(to).split("/").filter(Boolean)

  if (fromParts.length < 2 || toParts.length < 2)
    return res.status(400).json({ error: "Caminho inválido. Use: pasta/arquivo" })

  if (!ALLOWED_FOLDERS.includes(fromParts[0]) || !ALLOWED_FOLDERS.includes(toParts[0]))
    return res.status(400).json({ error: "Pasta inválida" })

  const safeSrcParts = fromParts.map(p => path.basename(p))
  const safeDstParts = toParts.map(p => path.basename(p))

  const srcPath = path.join(UPLOAD_DIR, ...safeSrcParts)
  const dstPath = path.join(UPLOAD_DIR, ...safeDstParts)

  if (!fs.existsSync(srcPath))
    return res.status(404).json({ error: "Arquivo não encontrado" })

  if (fs.existsSync(dstPath))
    return res.status(409).json({ error: "Já existe um arquivo com esse nome no destino" })

  try {
    fs.mkdirSync(path.dirname(dstPath), { recursive: true })
    fs.renameSync(srcPath, dstPath)
    console.log("[move] OK:", from, "→", to)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /mkdir?folder=X&subfolder=Y&name=Z  — cria subpasta
app.post("/mkdir", auth, (req, res) => {
  const folder    = req.query.folder
  const subfolder = safeSub(req.query.subfolder)
  const name      = req.query.name ? path.basename(req.query.name) : null

  if (!folder || !ALLOWED_FOLDERS.includes(folder))
    return res.status(400).json({ error: "Pasta inválida. Use: " + ALLOWED_FOLDERS.join(", ") })

  if (!name)
    return res.status(400).json({ error: "name é obrigatório" })

  const dirPath = subfolder
    ? path.join(UPLOAD_DIR, folder, subfolder, name)
    : path.join(UPLOAD_DIR, folder, name)

  try {
    fs.mkdirSync(dirPath, { recursive: true })
    console.log("[mkdir] OK:", dirPath)
    res.json({ success: true })
  } catch (err) {
    console.error("[mkdir] error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /health
app.get("/health", (_, res) => {
  try {
    const folders = {}
    let totalGeral = 0

    ALLOWED_FOLDERS.forEach((f) => {
      const dir = path.join(UPLOAD_DIR, f)
      if (!fs.existsSync(dir)) {
        folders[f] = { erro: "pasta não encontrada" }
        return
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const arquivosDiretos = entries.filter(e => e.isFile()).length
      const subpastasEntries = entries.filter(e => e.isDirectory())

      const subpastas = {}
      let totalSubpastas = 0

      subpastasEntries.forEach(sub => {
        const subDir = path.join(dir, sub.name)
        const subEntries = fs.readdirSync(subDir, { withFileTypes: true })
        const files = subEntries.filter(e => e.isFile()).map(e => e.name)
        subpastas[sub.name] = { total: files.length, arquivos: files }
        totalSubpastas += files.length
      })

      const total = arquivosDiretos + totalSubpastas
      totalGeral += total

      folders[f] = {
        total,
        ...(arquivosDiretos > 0 && { direto: arquivosDiretos }),
        ...subpastas,
      }
    })

    res.json({ status: "ok", total_arquivos: totalGeral, folders })
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message })
  }
})

// Error handler global
app.use((err, _req, res, _next) => {
  console.error("[error handler]", err.message)
  res.status(500).json({ error: err.message || "Erro interno" })
})

app.listen(PORT, () => {
  console.log("cpcon-files rodando em :" + PORT)
  console.log("Arquivos em:", UPLOAD_DIR)
  console.log("URL base:", BASE_URL)
  console.log("Limite upload: 5GB (multer) | Imagens: 5MB | PDFs: 20MB | Outros: 20MB")
})
