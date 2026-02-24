const express = require("express")
const multer = require("multer")
const path = require("path")
const fs = require("fs")
const { v4: uuidv4 } = require("uuid")

const app = express()
const PORT = process.env.PORT || 4000
const API_KEY = process.env.API_KEY || "change-me"
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/uploads"
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`

// Garante que o diretório de uploads existe
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// Auth middleware
function auth(req, res, next) {
  const key = req.headers["x-api-key"]
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" })
  next()
}

const ALLOWED_FOLDERS = ["material-apoio", "qrcodes", "questoes", "redacoes", "simulados", "videos"]

// Garante que todas as subpastas existem
ALLOWED_FOLDERS.forEach((folder) => {
  const dir = path.join(UPLOAD_DIR, folder)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// Multer: salva na subpasta informada via query ?folder=, preserva extensão, nome único via UUID
const storage = multer.diskStorage({
  destination: (req, _, cb) => {
    const folder = req.query.folder
    if (!folder || !ALLOWED_FOLDERS.includes(folder)) {
      return cb(new Error(`Pasta inválida. Use: ${ALLOWED_FOLDERS.join(", ")}`))
    }
    cb(null, path.join(UPLOAD_DIR, folder))
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

// POST /upload?folder=material-apoio — envia um arquivo, retorna a URL pública
app.post("/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" })

  const folder = req.query.folder
  const url = `${BASE_URL}/files/${folder}/${req.file.filename}`
  res.json({
    url,
    folder,
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
  })
})

// GET /files/:filename — serve o arquivo publicamente
app.use("/files", express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.set("Cache-Control", "public, max-age=31536000")
  },
}))

// DELETE /files/:folder/:filename — remove o arquivo
app.delete("/files/:folder/:filename", auth, (req, res) => {
  const folder = req.params.folder
  const filename = path.basename(req.params.filename) // evita path traversal

  if (!ALLOWED_FOLDERS.includes(folder)) {
    return res.status(400).json({ error: "Pasta inválida" })
  }

  const filepath = path.join(UPLOAD_DIR, folder, filename)
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: "Arquivo não encontrado" })

  fs.unlinkSync(filepath)
  res.json({ success: true })
})

// GET /health
app.get("/health", (_, res) => res.json({ status: "ok", files: fs.readdirSync(UPLOAD_DIR).length }))

app.listen(PORT, () => {
  console.log(`cpcon-files rodando em :${PORT}`)
  console.log(`Arquivos em: ${UPLOAD_DIR}`)
  console.log(`URL base: ${BASE_URL}`)
})
