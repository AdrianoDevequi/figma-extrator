'use strict';
/**
 * Extração do arquivo .fig (ZIP) em Node puro.
 *
 * O extract_archive.cjs do figma-parser chama o `unzip` do sistema, que não
 * existe no Windows fora do Git Bash. Só essa etapa é reimplementada aqui;
 * o parse kiwi continua sendo o do skill original.
 */
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

function isZip(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/** Impede path traversal em nomes de entrada do ZIP. */
function safeJoin(root, entryName) {
  const normalized = entryName.split('\\').join('/');
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function extractZip(file, outDir) {
  return new Promise((resolve, reject) => {
    const root = path.resolve(outDir);
    const files = [];
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry) => {
        const target = safeJoin(root, entry.fileName);
        if (!target) return zip.readEntry();
        if (entry.fileName.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
          return zip.readEntry();
        }
        zip.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const out = fs.createWriteStream(target);
          stream.pipe(out);
          out.on('close', () => {
            files.push({
              path: path.relative(root, target).split(path.sep).join('/'),
              size: entry.uncompressedSize,
            });
            zip.readEntry();
          });
          out.on('error', reject);
        });
      });
      zip.readEntry();
    });
  });
}

/** Produz canvas.fig + images/ + meta.json em outDir, como o extract_archive.cjs. */
async function extractArchive(figFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (!isZip(figFile)) {
    // .fig antigo: o próprio arquivo já é o binário fig-kiwi
    fs.copyFileSync(figFile, path.join(outDir, 'canvas.fig'));
    return { format: 'raw', files: [{ path: 'canvas.fig', size: fs.statSync(figFile).size }] };
  }
  const files = await extractZip(figFile, outDir);
  if (!fs.existsSync(path.join(outDir, 'canvas.fig'))) {
    throw new Error('canvas.fig não encontrado no .fig — o arquivo não parece um export válido do Figma.');
  }
  return { format: 'zip', files };
}

module.exports = { extractArchive, isZip };
