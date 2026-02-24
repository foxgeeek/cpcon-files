const express = require("express")
const multer = require("multer")
const path = require("path")
const fs = require("fs")
const { v4: uuidv4 } = require("uuid")

const app = express()
const PORT = process.env.PORT || 4000
const API_KEY = process.env.API_KEY || "change-me"
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/uploads"
const BASE_URL = process.env.BASE_URL || ("http://localhost:" + PORT)

const ALLOWED_FOLDERS = ["material-apoio", "qrcodes", "questoes", "redacoes", "simulados", "videos"]

// Garante que diretório raiz e todas as subpastas existem
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  ALLOWED_FOLDERS.forEach((folder) => {
    fs.mkdirSync(path.join(UPLOAD_DIR, folder), { recursive: true })
  })
  console.log(`Diretórios prontos em: ${UPLOAD_DIR}`)
} catch (err) {
  console.error("ERRO ao criar diretórios:", err.message)
}

// Auth middleware
function auth(req, res, next) {
  const key = req.headers["x-api-key"]
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" })
  next()
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, _, cb) => {
    const folder = req.query.folder
    if (!folder || !ALLOWED_FOLDERS.includes(folder)) {
      return cb(new Error(`Pasta inválida. Use: ${ALLOWED_FOLDERS.join(", ")}`))
    }
    const dest = path.join(UPLOAD_DIR, folder)
    // Garante que a pasta existe no momento do upload
    try {
      fs.mkdirSync(dest, { recursive: true })
    } catch (e) {
      return cb(new Error(`Erro ao acessar pasta: ${e.message}`))
    }
    cb(null, dest)
  },
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `${uuidv4()}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
})

// POST /upload?folder=material-apoio
app.post("/upload", auth, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      console.error("[upload] multer error:", err.message)
      return res.status(400).json({ error: err.message })
    }

    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado" })
    }

    const folder = req.query.folder
    const url = `${BASE_URL}/files/${folder}/${req.file.filename}`

    console.log(`[upload] OK: ${folder}/${req.file.filename} (${req.file.size} bytes)`)

    res.json({
      url,
      folder,
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    })
  })
})

// GET /files — serve arquivos publicamente
app.use("/files", express.static(UPLOAD_DIR, {
  setHeaders: (res) => res.set("Cache-Control", "public, max-age=31536000"),
}))

// DELETE /files/:folder/:filename
app.delete("/files/:folder/:filename", auth, (req, res) => {
  const folder = req.params.folder
  const filename = path.basename(req.params.filename)

  if (!ALLOWED_FOLDERS.includes(folder)) {
    return res.status(400).json({ error: "Pasta inválida" })
  }

  const filepath = path.join(UPLOAD_DIR, folder, filename)
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "Arquivo não encontrado" })
  }

  try {
    fs.unlinkSync(filepath)
    res.json({ success: true })
  } catch (err) {
    console.error("[delete] erro:", err.message)
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

// Error handler global — garante que sempre retorna JSON, nunca fecha conexão sem resposta
app.use((err, req, res, _next) => {
  console.error("[error handler]", err.message)
  res.status(500).json({ error: err.message || "Erro interno" })
})

app.listen(PORT, () => {
  console.log(`cpcon-files rodando em :${PORT}`)
  console.log(`Arquivos em: ${UPLOAD_DIR}`)
  console.log(`URL base: ${BASE_URL}`)
})
