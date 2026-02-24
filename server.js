const express    = require("express")
const multer     = require("multer")
const path       = require("path")
const fs         = require("fs")
const { execFile } = require("child_process")
const { promisify } = require("util")
const { v4: uuidv4 } = require("uuid")
const sharp      = require("sharp")

const execFileAsync = promisify(execFile)
const GS_TIMEOUT_MS = 60_000 // 60s máximo para ghostscript

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
const ALLOWED_FOLDERS = ["material-apoio", "qrcodes", "questoes", "redacoes", "simulados", "videos"]

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
    const dest = path.join(UPLOAD_DIR, folder)
    try { fs.mkdirSync(dest, { recursive: true }) } catch (e) { return cb(e) }
    cb(null, dest)
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase()
    const base = path.basename(file.originalname, ext)
    const slug = slugify(base)

    const idCurso      = req.query.id_curso
    const idDisciplina = req.query.id_disciplina
    const idProfessor  = req.query.id_professor

    const filename = (idCurso && idDisciplina && idProfessor)
      ? `${idCurso}-${idDisciplina}-${idProfessor}-${slug}${ext}`
      : uuidv4() + ext   // fallback sem IDs

    cb(null, filename)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB pré-compressão
})

// --- Compressão de imagem com sharp ---
async function compressImage(filepath) {
  const ext    = path.extname(filepath).toLowerCase()
  const format = ext === ".png" ? "png" : "jpeg"
  const tmp    = filepath + ".tmp"

  // Sempre comprime imagens (qualidade boa por padrão, reduz se necessário)
  const qualities = [80, 65, 50, 40]

  for (const quality of qualities) {
    await sharp(filepath)
      .resize({ width: 1920, withoutEnlargement: true })
      .toFormat(format, { quality })
      .toFile(tmp)

    const size = fs.statSync(tmp).size
    if (size <= MAX_SIZE_BYTES) {
      fs.renameSync(tmp, filepath)
      return size
    }
  }

  // Última tentativa: reduz resolução
  await sharp(filepath)
    .resize({ width: 1200, withoutEnlargement: true })
    .toFormat(format, { quality: 35 })
    .toFile(tmp)

  const finalSize = fs.statSync(tmp).size
  if (finalSize > MAX_SIZE_BYTES) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    fs.unlinkSync(filepath)
    throw new Error("Imagem não pôde ser comprimida abaixo de 5MB")
  }

  fs.renameSync(tmp, filepath)
  return finalSize
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
    console.warn("[compress] gs falhou:", err.message)
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    // gs falhou — valida só o tamanho original
    if (originalSize > PDF_MAX_BYTES) {
      fs.unlinkSync(filepath)
      throw new Error("PDF muito grande (" + (originalSize / 1024 / 1024).toFixed(1) + "MB). Máximo: 20MB")
    }
    return originalSize
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
      const url       = BASE_URL + "/files/" + folder + "/" + req.file.filename

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

// GET /files — serve arquivos publicamente
app.use("/files", express.static(UPLOAD_DIR, {
  setHeaders: (res) => res.set("Cache-Control", "public, max-age=31536000"),
}))

// GET /list/:folder — lista arquivos de uma pasta (requer auth)
app.get("/list/:folder", auth, (req, res) => {
  const folder = req.params.folder
  if (!ALLOWED_FOLDERS.includes(folder))
    return res.status(400).json({ error: "Pasta inválida" })
  const dir = path.join(UPLOAD_DIR, folder)
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  res.json({ folder, files })
})

// DELETE /files/:folder/:filename
app.delete("/files/:folder/:filename", auth, (req, res) => {
  const folder   = req.params.folder
  const filename = path.basename(req.params.filename)

  if (!ALLOWED_FOLDERS.includes(folder))
    return res.status(400).json({ error: "Pasta inválida" })

  const filepath = path.join(UPLOAD_DIR, folder, filename)
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: "Arquivo não encontrado" })

  try {
    fs.unlinkSync(filepath)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /health
app.get("/health", (_, res) => {
  try {
    const counts = {}
    ALLOWED_FOLDERS.forEach((f) => {
      const dir = path.join(UPLOAD_DIR, f)
      counts[f] = fs.existsSync(dir) ? fs.readdirSync(dir).length : "pasta não encontrada"
    })
    res.json({ status: "ok", folders: counts })
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
  console.log("Limite final por arquivo: 5MB")
})
