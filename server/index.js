'use strict';
/**
 * Servidor da interface: recebe o .fig, roda o pipeline e serve a exportação.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const { parseFig, exportScreens } = require('./pipeline');
const { screenTree } = require('./analyze');

const ROOT = path.join(__dirname, '..');
const RUNS_DIR = path.join(ROOT, '.runs');
const PORT = process.env.PORT || 4173;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 400);

fs.mkdirSync(RUNS_DIR, { recursive: true });

// Execuções vivas em memória: a análise é pesada e não vale reprocessar
// a cada clique na interface.
const runs = new Map();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const id = crypto.randomUUID();
      req.runId = id;
      const dir = path.join(RUNS_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'origem.fig'),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.fig$/i.test(file.originalname)) {
      return cb(new Error('Envie um arquivo com extensão .fig'));
    }
    cb(null, true);
  },
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function runOr404(req, res) {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ erro: 'Execução não encontrada. Envie o arquivo novamente.' });
    return null;
  }
  return run;
}

// ------------------------------------------------------------------ upload

app.post('/api/upload', (req, res) => {
  upload.single('arquivo')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Arquivo maior que o limite de ${MAX_UPLOAD_MB} MB.`
        : err.message;
      return res.status(400).json({ erro: msg });
    }
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo recebido.' });

    const id = req.runId;
    const runDir = path.join(RUNS_DIR, id);
    const steps = [];
    try {
      const parsed = await parseFig(req.file.path, runDir, (step, detail) => steps.push({ step, detail }));
      runs.set(id, { parsed, originalName: req.file.originalname, createdAt: Date.now() });

      const a = parsed.analysis;
      res.json({
        id,
        arquivo: req.file.originalname,
        tamanhoMB: Number((req.file.size / 1048576).toFixed(1)),
        meta: { nome: parsed.meta.file_name || null, exportadoEm: parsed.meta.exported_at || null },
        thumbnail: parsed.thumbnail ? `/api/run/${id}/arquivo/thumbnail.png` : null,
        escala: a.scale,
        stats: a.stats,
        imagens: parsed.imageMap.size,
        telas: a.screens.map((s) => ({
          guid: s.guid,
          nome: s.name,
          pagina: s.page,
          largura: s.width,
          altura: s.height,
          nos: s.nodeCount,
          tipo: s.kind,
          duplicada: Boolean(s.duplicateOf),
        })),
        etapas: steps,
      });
    } catch (e) {
      res.status(500).json({ erro: e.message || 'Falha ao processar o .fig' });
    }
  });
});

// ------------------------------------------------------------------- árvore

app.get('/api/run/:id/arvore/:guid', (req, res) => {
  const run = runOr404(req, res);
  if (!run) return;
  const depth = req.query.profundidade ? Number(req.query.profundidade) : 4;
  const tree = screenTree(run.parsed.analysis, req.params.guid, depth);
  if (!tree) return res.status(404).json({ erro: 'Tela não encontrada.' });
  res.json(tree);
});

// ---------------------------------------------------------------- exportação

app.post('/api/run/:id/exportar', (req, res) => {
  const run = runOr404(req, res);
  if (!run) return;
  const { telas, escala, modo, viewportMin, usarLinhas } = req.body || {};
  try {
    const out = exportScreens(run.parsed, {
      screens: Array.isArray(telas) ? telas : null,
      scaleFactor: escala ? Number(escala) : undefined,
      mode: modo === 'absolute' ? 'absolute' : 'fluid',
      minViewport: viewportMin ? Number(viewportMin) : 360,
      usarLinhas: usarLinhas !== false,
    });
    run.lastExport = out;
    res.json({
      manifest: out.manifest,
      telas: out.results.map((r) => ({
        ...r,
        preview: `/api/run/${req.params.id}/arquivo/${r.dir}/index.html`,
      })),
    });
  } catch (e) {
    res.status(500).json({ erro: e.message || 'Falha ao gerar a exportação' });
  }
});

// --------------------------------------------------- servir arquivos gerados

app.get('/api/run/:id/arquivo/*', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).send('Execução não encontrada.');
  const rel = req.params[0];
  const base = path.resolve(run.parsed.paths.outDir);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return res.status(403).send('Caminho inválido.');
  if (!fs.existsSync(target)) return res.status(404).send('Arquivo não encontrado.');
  res.sendFile(target);
});

// -------------------------------------------------------------------- download

app.get('/api/run/:id/download', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).send('Execução não encontrada.');
  const outDir = run.parsed.paths.outDir;
  if (!fs.existsSync(path.join(outDir, 'manifest.json'))) {
    return res.status(400).send('Gere a exportação antes de baixar.');
  }
  const name = (run.originalName || 'figma').replace(/\.fig$/i, '');
  res.attachment(`${name}-exportacao.zip`);
  const zip = archiver('zip', { zlib: { level: 9 } });
  zip.on('error', (e) => res.status(500).end(String(e.message)));
  zip.pipe(res);
  zip.directory(outDir, false);
  // JSON bruto do parser: opcional, costuma passar de 40 MB
  if (req.query.bruto === '1') zip.file(run.parsed.paths.messagePath, { name: 'bruto/message.json' });
  zip.finalize();
});

// -------------------------------------------------------------------- limpeza

app.delete('/api/run/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ erro: 'Execução não encontrada.' });
  runs.delete(req.params.id);
  fs.rm(path.join(RUNS_DIR, req.params.id), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Extrator de .fig rodando em http://localhost:${PORT}`);
});
