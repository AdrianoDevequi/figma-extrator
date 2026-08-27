'use strict';
/**
 * Orquestra a extração completa de um .fig.
 *
 * Etapas: unzip -> decode kiwi (script do skill) -> análise -> geração.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { extractArchive } = require('./unzip');
const { analyze, screenTree } = require('./analyze');
const { generateScreen, slugify } = require('./generate');

const PARSER_DIR = path.join(__dirname, '..', 'vendor', 'figma-parser');

function runNode(script, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).toString().slice(0, 2000)));
        resolve(stdout.toString());
      }
    );
  });
}

// -------------------------------------------------------------------- imagens

const MAGIC = [
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

function sniffExt(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  for (const m of MAGIC) {
    if (m.bytes.every((b, i) => head[i] === b)) {
      if (m.ext === 'webp' && head.slice(8, 12).toString() !== 'WEBP') continue;
      return m.ext;
    }
  }
  return 'png';
}

/** Copia images/<hash> para assets/images/<hash>.<ext> com a extensão correta. */
function prepareImages(extractDir, assetsDir) {
  const src = path.join(extractDir, 'images');
  const map = new Map();
  if (!fs.existsSync(src)) return map;
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    if (!fs.statSync(from).isFile()) continue;
    const ext = sniffExt(from);
    const fileName = `${name}.${ext}`;
    fs.copyFileSync(from, path.join(assetsDir, fileName));
    map.set(name, fileName);
  }
  return map;
}

// -------------------------------------------------------------------- resumo

function summarizeScreen(tree, scaleFactor, tokens, imageMap) {
  const blocks = [];
  const f = scaleFactor || 1;
  const walk = (n, depth) => {
    if (n.visible === false) return;
    if (depth > 0 && depth <= 2) {
      const fill = (n.fills || []).find((x) => x.type === 'SOLID');
      const img = (n.fills || []).find((x) => x.type === 'IMAGE' && x.imageHash);
      blocks.push({
        depth,
        name: n.name,
        type: n.type,
        x: n.position ? Number((n.position.x / f).toFixed(1)) : null,
        y: n.position ? Number((n.position.y / f).toFixed(1)) : null,
        w: n.size ? Number((n.size.w / f).toFixed(1)) : null,
        h: n.size ? Number((n.size.h / f).toFixed(1)) : null,
        background: fill ? fill.color : null,
        image: img ? imageMap.get(img.imageHash) || null : null,
        layout: n.layout ? `${n.layout.mode === 'HORIZONTAL' ? 'row' : 'column'}${n.gap ? ' gap ' + Number((n.gap / f).toFixed(1)) : ''}` : null,
        text: n.type === 'TEXT' ? n.text.slice(0, 120) : null,
        font:
          n.type === 'TEXT' && n.fontSize
            ? `${n.fontFamily || '?'} ${n.fontWeight || 400} ${Number((n.fontSize / f).toFixed(2))}px`
            : null,
      });
    }
    for (const c of n.children || []) walk(c, depth + 1);
  };
  walk(tree, 0);
  return {
    name: tree.name,
    width: Number((tree.size.w / f).toFixed(2)),
    height: Number((tree.size.h / f).toFixed(2)),
    blockCount: blocks.length,
    blocks,
    tokens: {
      colors: tokens.colors.slice(0, 16),
      fontSizes: tokens.fontSizes.slice(0, 16),
      fonts: tokens.fonts,
      radii: tokens.radii.slice(0, 8),
      shadows: tokens.shadows.slice(0, 6),
    },
  };
}

// ------------------------------------------------------------------ pipeline

/**
 * @param {string} figPath  arquivo .fig enviado
 * @param {string} runDir   diretório de trabalho/saída da execução
 * @param {(step:string, detail?:string)=>void} onProgress
 */
async function parseFig(figPath, runDir, onProgress) {
  const report = onProgress || (() => {});
  const extractDir = path.join(runDir, 'extract');
  const outDir = path.join(runDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  report('extract', 'Abrindo o arquivo .fig');
  const archive = await extractArchive(figPath, extractDir);

  report('decode', 'Decodificando o binário kiwi');
  const messagePath = path.join(runDir, 'message.json');
  const decodeLog = await runNode(
    path.join(PARSER_DIR, 'decode_kiwi.cjs'),
    [path.join(extractDir, 'canvas.fig'), messagePath],
    PARSER_DIR
  );

  report('analyze', 'Montando a árvore de nós');
  const message = JSON.parse(fs.readFileSync(messagePath, 'utf8'));
  const analysis = analyze(message);

  report('images', 'Separando as imagens embutidas');
  const imageMap = prepareImages(extractDir, path.join(outDir, 'assets', 'images'));

  let meta = {};
  const metaPath = path.join(extractDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      meta = {};
    }
  }

  const thumbSrc = path.join(extractDir, 'thumbnail.png');
  let thumbnail = null;
  if (fs.existsSync(thumbSrc)) {
    fs.copyFileSync(thumbSrc, path.join(outDir, 'thumbnail.png'));
    thumbnail = 'thumbnail.png';
  }

  return {
    analysis,
    imageMap,
    meta,
    thumbnail,
    archive,
    decodeLog,
    paths: { runDir, extractDir, outDir, messagePath },
  };
}

/** Gera HTML/CSS/resumo para as telas escolhidas e escreve em out/. */
function exportScreens(parsed, options) {
  const opts = options || {};
  const { analysis, imageMap, paths } = parsed;
  const scaleFactor = opts.scaleFactor || analysis.scale.factor || 1;
  const mode = opts.mode || 'fluid';
  const wanted = opts.screens && opts.screens.length ? new Set(opts.screens) : null;

  const screens = analysis.screens.filter((s) => (wanted ? wanted.has(s.guid) : s.kind === 'page' && !s.duplicateOf));

  const results = [];
  const usedNames = new Map();

  for (const s of screens) {
    const tree = screenTree(analysis, s.guid);
    let base = slugify(s.name) || 'tela';
    const n = usedNames.get(base) || 0;
    usedNames.set(base, n + 1);
    if (n) base = `${base}-${n + 1}`;

    const generated = generateScreen(tree, {
      scaleFactor,
      mode,
      minViewport: opts.minViewport || 360,
      imageFile: (hash) => {
        const file = imageMap.get(hash);
        return file ? `./assets/images/${file}` : null;
      },
    });

    const dir = path.join(paths.outDir, 'telas', base);
    fs.mkdirSync(dir, { recursive: true });
    // O CSS referencia ./assets/images a partir da raiz de out/
    const html = generated.html.replace('href="./styles.css"', 'href="./styles.css"');
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(
      path.join(dir, 'styles.css'),
      generated.css.split('./assets/images/').join('../../assets/images/')
    );

    const summary = summarizeScreen(tree, scaleFactor, generated.tokens, imageMap);
    fs.writeFileSync(path.join(dir, 'resumo.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(dir, 'resumo.md'), summaryToMarkdown(summary, scaleFactor, mode));
    fs.writeFileSync(path.join(dir, 'arvore.json'), JSON.stringify(tree, null, 2));

    results.push({
      guid: s.guid,
      name: s.name,
      slug: base,
      width: summary.width,
      height: summary.height,
      blockCount: summary.blockCount,
      tokens: summary.tokens,
      dir: path.relative(paths.outDir, dir).split(path.sep).join('/'),
    });
  }

  const manifest = {
    geradoEm: new Date().toISOString(),
    arquivo: parsed.meta.file_name || null,
    escala: { fator: scaleFactor, ...analysis.scale },
    modo: mode,
    telas: results,
    imagens: imageMap.size,
    stats: analysis.stats,
  };
  fs.writeFileSync(path.join(paths.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(paths.outDir, 'LEIA-ME.md'), manifestToMarkdown(manifest));

  return { manifest, results };
}

function summaryToMarkdown(s, scaleFactor, mode) {
  const l = [];
  l.push(`# ${s.name}`);
  l.push('');
  l.push(`- Dimensões: **${s.width} x ${s.height}px**`);
  l.push(`- Fator de escala aplicado: **${scaleFactor}**`);
  l.push(`- Modo de geração: **${mode}**`);
  l.push(`- Blocos mapeados: **${s.blockCount}**`);
  l.push('');
  l.push('## Paleta');
  l.push('');
  l.push('| Cor | Ocorrências |');
  l.push('| --- | --- |');
  for (const c of s.tokens.colors) l.push(`| \`${c.value}\` | ${c.count} |`);
  l.push('');
  l.push('## Tipografia');
  l.push('');
  l.push('| Fonte | Peso | Ocorrências |');
  l.push('| --- | --- | --- |');
  for (const f of s.tokens.fonts) l.push(`| ${f.family} | ${f.weight} | ${f.count} |`);
  l.push('');
  l.push(`Tamanhos: ${s.tokens.fontSizes.map((f) => f.value + 'px').join(', ')}`);
  l.push('');
  l.push('## Blocos');
  l.push('');
  l.push('| Nível | Bloco | Tipo | Posição | Tamanho | Fundo | Layout | Conteúdo |');
  l.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const b of s.blocks) {
    const pos = b.x === null ? '-' : `${b.x}, ${b.y}`;
    const size = b.w === null ? '-' : `${b.w} x ${b.h}`;
    const content = b.text ? `"${b.text.replace(/\|/g, '\\|').replace(/\n/g, ' ')}"` : b.image ? `img ${b.image}` : '';
    const font = b.font ? ` (${b.font})` : '';
    l.push(
      `| ${b.depth} | ${String(b.name).replace(/\|/g, '\\|')} | ${b.type} | ${pos} | ${size} | ${b.background || '-'} | ${b.layout || '-'} | ${content}${font} |`
    );
  }
  l.push('');
  return l.join('\n');
}

function manifestToMarkdown(m) {
  const l = [];
  l.push('# Exportação do arquivo .fig');
  l.push('');
  l.push(`Gerado em ${m.geradoEm}`);
  if (m.arquivo) l.push(`Arquivo original: **${m.arquivo}**`);
  l.push('');
  l.push('## Escala');
  l.push('');
  l.push(`- Fator aplicado: **${m.escala.fator}**`);
  l.push(`- Largura do frame raiz: ${m.escala.rootWidth}px`);
  l.push(`- Largura de design reconstruída: ${m.escala.baseWidth}px`);
  l.push(`- Diagnóstico: ${m.escala.reason}`);
  if (m.escala.candidates) {
    l.push('');
    l.push('| Fator | Largura de design | Encaixe |');
    l.push('| --- | --- | --- |');
    for (const c of m.escala.candidates) l.push(`| ${c.factor} | ${c.baseWidth}px | ${(c.score * 100).toFixed(1)}% |`);
  }
  l.push('');
  l.push('## Conteúdo');
  l.push('');
  l.push(`- Nós no documento: ${m.stats.totalNodes}`);
  l.push(`- Nós com auto-layout: ${m.stats.autoLayout}`);
  l.push(`- Preenchimentos de imagem: ${m.stats.imageFills}`);
  l.push(`- Textos com formatação mista: ${m.stats.mixedText}`);
  l.push(`- Imagens exportadas: ${m.imagens}`);
  l.push('');
  l.push('## Telas');
  l.push('');
  l.push('| Tela | Dimensões | Blocos | Pasta |');
  l.push('| --- | --- | --- | --- |');
  for (const t of m.telas) l.push(`| ${t.name} | ${t.width} x ${t.height} | ${t.blockCount} | \`${t.dir}\` |`);
  l.push('');
  l.push('## Limitação conhecida');
  l.push('');
  l.push(
    'Ícones vetoriais guardam o traçado em `vectorNetworkBlob`, um formato binário fechado ' +
      'do Figma sem decodificador público. Eles saem como caixas posicionadas e dimensionadas, ' +
      'sem o path. Para obter o SVG é preciso a API do Figma com o arquivo na nuvem.'
  );
  l.push('');
  return l.join('\n');
}

module.exports = { parseFig, exportScreens, prepareImages };
