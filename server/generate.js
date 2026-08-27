'use strict';
/**
 * Gera HTML/CSS a partir da árvore analisada.
 *
 * Dois modos:
 *   - "fluid"    (padrão): auto-layout vira flex, medidas viram clamp() entre
 *                 360px e a largura do design; classes semânticas.
 *   - "absolute": posicionamento absoluto fiel ao pixel, para conferência.
 */

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPE[c]);
}

function round(v, p) {
  const f = Math.pow(10, p === undefined ? 2 : p);
  return Math.round(v * f) / f;
}

// ------------------------------------------------------------- nomes de classe

const STOPWORDS = new Set(['frame', 'group', 'rectangle', 'ellipse', 'vector', 'component', 'instance', 'property', 'line']);

function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Classe semântica: prefere o papel do nó ao nome da camada do Figma.
 * "Frame 140" vira "section", "Header" continua "header".
 */
function semanticClass(node, role) {
  // Camada de texto no Figma é auto-nomeada pelo próprio conteúdo; usar isso
  // como classe gera nomes enormes e nada semânticos.
  if (node.type === 'TEXT' && node.text) {
    const n = node.name.trim();
    const t = node.text.trim();
    if (n === t || t.startsWith(n) || n.length > 24) return role;
  }
  const slug = slugify(node.name);
  const meaningful =
    slug &&
    !/^\d+$/.test(slug) &&
    !STOPWORDS.has(slug.split('-')[0]) &&
    !/^(frame|group|rectangle|ellipse|vector|line)-?\d*$/.test(slug);
  if (meaningful) return slug;
  return role;
}

/** Papel inferido a partir do tipo e da geometria. */
function roleOf(node, depth, ctx) {
  if (node.type === 'TEXT') {
    const size = node.fontSize || 16;
    if (size >= ctx.h1Threshold) return 'heading-xl';
    if (size >= ctx.h2Threshold) return 'heading';
    if (size <= ctx.smallThreshold) return 'caption';
    return 'text';
  }
  if (isImageNode(node)) return 'media';
  if (node.type === 'ELLIPSE') return 'dot';
  if (node.type === 'LINE') return 'rule';
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') return 'icon';
  if (depth === 1) return 'section';
  if (node.layout) return node.layout.mode === 'HORIZONTAL' ? 'row' : 'stack';
  return 'box';
}

function isImageNode(node) {
  return (node.fills || []).some((f) => f.type === 'IMAGE' && f.imageHash);
}

// ------------------------------------------------------------------- tokens

/** Varre a árvore e monta a paleta, a escala tipográfica, raios e sombras. */
function collectTokens(root, scaleFactor) {
  const colors = new Map();
  const fonts = new Map();
  const sizes = new Map();
  const radii = new Map();
  const shadows = new Map();
  const families = new Set();

  const visit = (n) => {
    for (const f of n.fills || []) {
      if (f.type === 'SOLID' && f.color) colors.set(f.color, (colors.get(f.color) || 0) + 1);
    }
    for (const s of n.strokes || []) {
      if (s.type === 'SOLID' && s.color) colors.set(s.color, (colors.get(s.color) || 0) + 1);
    }
    if (n.type === 'TEXT') {
      const size = round((n.fontSize || 16) / scaleFactor, 2);
      sizes.set(size, (sizes.get(size) || 0) + 1);
      if (n.fontFamily) {
        families.add(n.fontFamily);
        const key = `${n.fontFamily}|${n.fontWeight || 400}`;
        fonts.set(key, (fonts.get(key) || 0) + 1);
      }
    }
    const r = n.cornerRadius || (n.cornerRadii && Math.max(...n.cornerRadii));
    if (r) {
      const v = round(r / scaleFactor, 2);
      radii.set(v, (radii.get(v) || 0) + 1);
    }
    for (const e of n.effects || []) {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        const css = shadowCss(e, scaleFactor);
        if (css) shadows.set(css, (shadows.get(css) || 0) + 1);
      }
    }
    for (const c of n.children || []) visit(c);
  };
  visit(root);

  const rank = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

  return {
    colors: rank(colors).map(([value, count], i) => ({ name: `color-${i + 1}`, value, count })),
    fontSizes: [...sizes.entries()].sort((a, b) => b[0] - a[0]).map(([value, count]) => ({ value, count })),
    fonts: rank(fonts).map(([key, count]) => {
      const [family, weight] = key.split('|');
      return { family, weight: Number(weight), count };
    }),
    families: [...families],
    radii: [...radii.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count })),
    shadows: rank(shadows).map(([value, count], i) => ({ name: `shadow-${i + 1}`, value, count })),
  };
}

function shadowCss(e, scaleFactor) {
  if (!e.color) return null;
  const f = scaleFactor || 1;
  const x = round((e.offset ? e.offset.x : 0) / f, 1);
  const y = round((e.offset ? e.offset.y : 0) / f, 1);
  const blur = round((e.radius || 0) / f, 1);
  const spread = round((e.spread || 0) / f, 1);
  const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
  return `${inset}${x}px ${y}px ${blur}px ${spread}px ${e.color}`;
}

// -------------------------------------------------------------- medidas fluidas

/**
 * Converte px do design em medida fluida.
 *
 * A unidade é `cqw` (1% da largura do contêiner raiz), não `vw`. Com vw as
 * medidas continuam crescendo depois que a raiz trava no max-width, e aí o
 * eixo horizontal (em %) descola do vertical. Com cqw os dois eixos usam a
 * mesma referência e o layout escala junto, como um zoom.
 */
function makeFluid(designWidth, minViewport) {
  const minVw = minViewport === undefined ? 360 : minViewport;
  return function fluid(px, opts) {
    const o = opts || {};
    const v = round(px, 2);
    if (!v) return '0';
    if (Math.abs(v) < (o.threshold === undefined ? 2 : o.threshold)) return `${v}px`;
    const cqw = round((v / designWidth) * 100, 4);
    let min = round(v * (minVw / designWidth), 2);
    if (o.minPx !== undefined) min = Math.max(min, o.minPx);
    if (min >= v) return `${v}px`;
    return `clamp(${min}px, ${cqw}cqw, ${v}px)`;
  };
}

// ---------------------------------------------------------------- estilos do nó

const ALIGN = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
  SPACE_EVENLY: 'space-evenly',
  STRETCH: 'stretch',
  BASELINE: 'baseline',
};

const TEXT_ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };

function backgroundDeclarations(node, ctx) {
  const decls = [];
  const fills = (node.fills || []).filter((f) => f.opacity !== 0);
  if (!fills.length) return decls;
  // O Figma pinta de baixo para cima; em CSS a primeira camada fica por cima.
  const layers = [];
  let solid = null;
  for (const f of fills) {
    if (f.type === 'SOLID') solid = f.color;
    else if (f.css) layers.unshift(f.css);
    else if (f.type === 'IMAGE' && f.imageHash) {
      const file = ctx.imageFile(f.imageHash);
      if (file) {
        layers.unshift(`url("${file}") ${imagePosition(f)}`);
      }
    }
  }
  if (layers.length) decls.push(['background', layers.join(', ') + (solid ? `, ${solid}` : '')]);
  else if (solid) decls.push(['background-color', solid]);
  return decls;
}

function imagePosition(fill) {
  const mode = fill.scaleMode;
  if (mode === 'FIT') return 'center / contain no-repeat';
  if (mode === 'TILE') return 'center / auto repeat';
  if (mode === 'STRETCH') return 'center / 100% 100% no-repeat';
  return 'center / cover no-repeat';
}

function borderDeclarations(node, ctx) {
  const decls = [];
  const stroke = (node.strokes || []).find((s) => s.type === 'SOLID' && s.color);
  if (!stroke) return decls;
  const w = round((node.strokeWeight || 1) / ctx.scaleFactor, 2);
  // INSIDE é o padrão do Figma; box-sizing:border-box já reproduz isso.
  decls.push(['border', `${w}px solid ${stroke.color}`]);
  return decls;
}

function radiusDeclaration(node, ctx) {
  if (node.cornerRadii) {
    const [tl, tr, br, bl] = node.cornerRadii.map((r) => round(r / ctx.scaleFactor, 2));
    if (tl || tr || br || bl) return [['border-radius', `${tl}px ${tr}px ${br}px ${bl}px`]];
  }
  if (node.cornerRadius) {
    const r = round(node.cornerRadius / ctx.scaleFactor, 2);
    if (r) return [['border-radius', `${r}px`]];
  }
  return [];
}

function textDeclarations(node, ctx) {
  const decls = [];
  const f = ctx.scaleFactor;
  if (node.fontFamily) {
    decls.push(['font-family', `var(--font-${slugify(node.fontFamily)}, "${node.fontFamily}"), sans-serif`]);
  }
  if (node.fontSize) {
    decls.push(['font-size', ctx.fluid(node.fontSize / f, { minPx: 12 })]);
  }
  if (node.fontWeight && node.fontWeight !== 400) decls.push(['font-weight', String(node.fontWeight)]);
  if (node.italic) decls.push(['font-style', 'italic']);
  if (node.lineHeight) {
    if (node.lineHeight.units === 'PERCENT') {
      decls.push(['line-height', String(round(node.lineHeight.value / 100, 3))]);
    } else if (node.lineHeight.value) {
      const ratio = node.fontSize ? node.lineHeight.value / node.fontSize : null;
      decls.push(['line-height', ratio ? String(round(ratio, 3)) : `${round(node.lineHeight.value / f, 2)}px`]);
    }
  }
  if (node.letterSpacing && node.letterSpacing.value) {
    if (node.letterSpacing.units === 'PERCENT') {
      decls.push(['letter-spacing', `${round(node.letterSpacing.value / 100, 4)}em`]);
    } else {
      decls.push(['letter-spacing', `${round(node.letterSpacing.value / f, 3)}px`]);
    }
  }
  if (node.textAlign && node.textAlign !== 'LEFT') {
    decls.push(['text-align', TEXT_ALIGN[node.textAlign] || 'left']);
  }
  if (node.textCase === 'UPPER') decls.push(['text-transform', 'uppercase']);
  else if (node.textCase === 'LOWER') decls.push(['text-transform', 'lowercase']);
  else if (node.textCase === 'TITLE') decls.push(['text-transform', 'capitalize']);
  if (node.textDecoration === 'UNDERLINE') decls.push(['text-decoration', 'underline']);
  else if (node.textDecoration === 'STRIKETHROUGH') decls.push(['text-decoration', 'line-through']);

  const fill = (node.fills || []).find((x) => x.type === 'SOLID' && x.color);
  if (fill) decls.push(['color', fill.color]);
  return decls;
}

function layoutDeclarations(node, parent, ctx, ownStrategy) {
  const decls = [];
  const f = ctx.scaleFactor;

  if (node.layout) {
    decls.push(['display', 'flex']);
    decls.push(['flex-direction', node.layout.mode === 'HORIZONTAL' ? 'row' : 'column']);
    if (node.layout.wrap === 'WRAP') decls.push(['flex-wrap', 'wrap']);
    if (node.gap) decls.push(['gap', ctx.fluid(node.gap / f)]);
    const primary = ALIGN[node.layout.primaryAlign] || 'flex-start';
    const counter = ALIGN[node.layout.counterAlign] || 'stretch';
    if (primary !== 'flex-start') decls.push(['justify-content', primary]);
    if (counter !== 'stretch') decls.push(['align-items', counter]);
    const p = node.padding;
    if (p && (p.top || p.right || p.bottom || p.left)) {
      const parts = [p.top, p.right, p.bottom, p.left].map((v) => ctx.fluid((v || 0) / f));
      decls.push(['padding', parts.join(' ')]);
    }
  }

  // Dimensões
  const size = node.size;
  if (!size) return decls;
  const parentLayout = parent && parent.layout;
  const isHorizontal = parentLayout && parentLayout.mode === 'HORIZONTAL';

  const hugsWidth = node.layout && (isHorizontal ? node.layout.primarySizing : node.layout.counterSizing) === 'RESIZE_TO_FIT';
  const fillsWidth = node.grow === 1 && isHorizontal;

  if (fillsWidth) {
    decls.push(['flex', '1 1 0']);
    decls.push(['min-width', '0']);
  } else if (parentLayout && !isHorizontal && node.alignSelf === 'STRETCH') {
    decls.push(['align-self', 'stretch']);
  } else if (!hugsWidth && node.type !== 'TEXT') {
    decls.push(['width', ctx.fluid(size.w / f)]);
  }

  // Altura.
  //
  // Se os filhos deste nó são posicionados pelo desenho (sem auto-layout), a
  // altura também vem do desenho — senão a caixa cresce com o conteúdo e o
  // erro empurra tudo que vem abaixo. Onde há auto-layout, quem manda é o
  // conteúdo, que é justamente o que o auto-layout significa.
  const dirigidoPeloDesenho = ownStrategy === 'flow' || ownStrategy === 'absolute';
  const conteudoDefineAltura =
    node.type === 'TEXT' ||
    (node.layout && node.layout.mode === 'VERTICAL' && node.layout.primarySizing === 'RESIZE_TO_FIT');

  if (size.h) {
    if (dirigidoPeloDesenho && (node.children || []).length) {
      decls.push(['height', ctx.fluid(size.h / f)]);
    } else if (!conteudoDefineAltura) {
      if (ctx.mode === 'absolute') decls.push(['height', ctx.fluid(size.h / f)]);
      else decls.push(['min-height', ctx.fluid(size.h / f)]);
    }
  }

  if (node.grow === 1 && parentLayout && !isHorizontal) decls.push(['flex', '1 1 auto']);

  return decls;
}

function absoluteDeclarations(node, parent, ctx) {
  const decls = [['position', 'absolute']];
  const f = ctx.scaleFactor;
  const x = node.position ? node.position.x : 0;
  const y = node.position ? node.position.y : 0;
  const parentW = parent && parent.size ? parent.size.w : ctx.designWidth * f;
  // Horizontal em % do pai; vertical em medida fluida. Ambos acompanham a
  // largura do contêiner raiz, então os dois eixos escalam na mesma proporção.
  decls.push(['left', `${round((x / parentW) * 100, 3)}%`]);
  decls.push(['top', ctx.fluid(y / f)]);
  if (node.size) {
    decls.push(['width', `${round((node.size.w / parentW) * 100, 3)}%`]);
    decls.push(['height', ctx.fluid(node.size.h / f)]);
  }
  return decls;
}

/**
 * Como dispor os filhos de um nó.
 *   'flex'     - o nó tem auto-layout no Figma;
 *   'flow'     - sem auto-layout, mas os filhos se empilham na vertical sem
 *                se sobrepor: vira fluxo normal com margens (bem mais legível
 *                e responsivo que absoluto);
 *   'absolute' - os filhos se sobrepõem; só o posicionamento absoluto preserva.
 */
function childLayoutStrategy(node, preferFlow) {
  if (node.layout) return 'flex';
  const kids = (node.children || []).filter((c) => c.visible !== false && c.size && c.position);
  if (!kids.length) return 'absolute';

  // Empilhar por margens produz HTML mais limpo, mas o erro de altura de cada
  // bloco (texto quebra em menos linhas no navegador que no Figma) se soma
  // bloco a bloco e desloca tudo abaixo. O absoluto ancora cada filho no pai:
  // um erro fica contido no próprio bloco. Fidelidade ganha de estética aqui.
  if (!preferFlow) return 'absolute';

  const boxes = kids
    .map((c) => ({ top: c.position.y, bottom: c.position.y + c.size.h }))
    .sort((a, b) => a.top - b.top);
  const tol = 1;
  for (let i = 1; i < boxes.length; i++) {
    if (boxes[i].top < boxes[i - 1].bottom - tol) return 'absolute';
  }
  return 'flow';
}

/** Empilhamento em fluxo: margem superior reproduz o espaço vertical do Figma. */
function flowDeclarations(node, parent, ctx, previousSibling) {
  const decls = [];
  const f = ctx.scaleFactor;
  const y = node.position ? node.position.y : 0;
  const prevBottom = previousSibling && previousSibling.position && previousSibling.size
    ? previousSibling.position.y + previousSibling.size.h
    : 0;
  const gap = y - prevBottom;
  if (Math.abs(gap) > 0.5) decls.push(['margin-top', ctx.fluid(gap / f)]);

  const parentW = parent && parent.size ? parent.size.w : null;
  const x = node.position ? node.position.x : 0;
  if (parentW && node.size) {
    decls.push(['width', `${round((node.size.w / parentW) * 100, 3)}%`]);
    if (x > 0.5) decls.push(['margin-left', `${round((x / parentW) * 100, 3)}%`]);
    // A margem seguinte é medida a partir da base desenhada deste bloco, então
    // a altura dele precisa ser a do desenho — exceto em texto, que respira.
    if (node.type !== 'TEXT' && node.size.h) decls.push(['height', ctx.fluid(node.size.h / f)]);
    else if (node.type === 'TEXT' && node.size.h) decls.push(['min-height', ctx.fluid(node.size.h / f)]);
  }
  return decls;
}

// ------------------------------------------------------------------- geração

const HEADING_TAGS = { 'heading-xl': 'h1', heading: 'h2' };

function tagFor(node, role) {
  if (node.type === 'TEXT') {
    if (HEADING_TAGS[role]) return HEADING_TAGS[role];
    return 'p';
  }
  if (role === 'section') return 'section';
  if (/header|topbar|navbar/.test(role)) return 'header';
  if (/footer|rodape/.test(role)) return 'footer';
  if (/nav|menu/.test(role)) return 'nav';
  if (/button|btn|cta/.test(role)) return 'button';
  return 'div';
}

/** Texto com formatação mista vira <span> por trecho. */
function renderTextContent(node, ctx) {
  if (!node.textRuns) return esc(node.text).replace(/\n/g, '<br>');
  return node.textRuns
    .map((run) => {
      if (!run.style) return esc(run.text).replace(/\n/g, '<br>');
      const parts = [];
      const s = run.style;
      if (s.fontSize) parts.push(`font-size:${ctx.fluid(s.fontSize / ctx.scaleFactor, { minPx: 12 })}`);
      if (s.fontFamily) parts.push(`font-family:"${s.fontFamily}", sans-serif`);
      if (s.fontStyle) {
        const w = require('./analyze').fontWeightFromStyle(s.fontStyle);
        if (w && w !== 400) parts.push(`font-weight:${w}`);
        if (/italic/i.test(s.fontStyle)) parts.push('font-style:italic');
      }
      if (s.color) parts.push(`color:${s.color}`);
      if (s.textDecoration === 'UNDERLINE') parts.push('text-decoration:underline');
      const style = parts.length ? ` style="${parts.join(';')}"` : '';
      return `<span class="run"${style}>${esc(run.text).replace(/\n/g, '<br>')}</span>`;
    })
    .join('');
}

function generateScreen(tree, options) {
  const opts = options || {};
  const scaleFactor = opts.scaleFactor || 1;
  const mode = opts.mode === 'absolute' ? 'absolute' : 'fluid';
  const designWidth = round((tree.size ? tree.size.w : 1440) / scaleFactor, 2);

  const tokens = collectTokens(tree, scaleFactor);

  // Limiares de tipografia derivados da própria escala do arquivo
  const allSizes = tokens.fontSizes.map((s) => s.value).sort((a, b) => b - a);
  const ctx = {
    scaleFactor,
    mode,
    designWidth,
    fluid: makeFluid(designWidth, opts.minViewport || 360),
    h1Threshold: allSizes.length ? allSizes[Math.min(1, allSizes.length - 1)] : 40,
    h2Threshold: allSizes.length ? allSizes[Math.min(Math.floor(allSizes.length * 0.25), allSizes.length - 1)] : 24,
    smallThreshold: allSizes.length ? allSizes[allSizes.length - 1] : 12,
    imageFile: opts.imageFile || (() => null),
    rastreio: opts.rastreio !== false,
    preferirFluxo: opts.preferirFluxo === true,
  };

  const rules = [];
  const usedClasses = new Map();
  const html = [];

  function classNameFor(node, role) {
    let base = semanticClass(node, role);
    if (!base) base = role;
    const count = usedClasses.get(base) || 0;
    usedClasses.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }

  function walk(node, parent, depth, indent, parentStrategy, previousSibling) {
    if (node.visible === false) return;
    if (node.type === 'CANVAS' || node.type === 'DOCUMENT') return;

    const role = roleOf(node, depth, ctx);
    const cls = classNameFor(node, role);
    const tag = tagFor(node, role);
    const isRoot = depth === 0;
    const strategy = mode === 'absolute' && !isRoot ? 'absolute' : childLayoutStrategy(node, ctx.preferirFluxo);

    const decls = [];

    if (isRoot) {
      // O contêiner de referência é o .canvas que envolve este nó, não ele
      // mesmo: em CSS, `container-type` não vale para as próprias propriedades
      // do elemento — `cqw` aqui resolveria contra a viewport.
      decls.push(['position', 'relative']);
      decls.push(['width', '100%']);
      if (node.size) decls.push(['min-height', ctx.fluid(node.size.h / ctx.scaleFactor)]);
    } else if (parentStrategy === 'absolute') {
      decls.push(...absoluteDeclarations(node, parent, ctx));
    } else if (parentStrategy === 'flow') {
      decls.push(...flowDeclarations(node, parent, ctx, previousSibling));
    }

    const layoutDecls = layoutDeclarations(node, parent, ctx, strategy);
    for (const [k, v] of layoutDecls) {
      // Em absoluto/fluxo a dimensão já saiu em % do pai; não sobrescreve.
      if ((k === 'width' || k === 'height') && parentStrategy !== 'flex' && parentStrategy !== null && !isRoot) continue;
      if (isRoot && (k === 'width' || k === 'min-height' || k === 'height' || k === 'max-width')) continue;
      decls.push([k, v]);
    }

    decls.push(...backgroundDeclarations(node, ctx));
    decls.push(...borderDeclarations(node, ctx));
    decls.push(...radiusDeclaration(node, ctx));
    if (node.type === 'TEXT') decls.push(...textDeclarations(node, ctx));
    if (node.opacity !== undefined && node.opacity < 1) decls.push(['opacity', String(round(node.opacity, 3))]);
    if (node.rotation) decls.push(['transform', `rotate(${node.rotation}deg)`]);
    if (node.clipsContent) decls.push(['overflow', 'hidden']);
    // Filhos absolutos precisam de um bloco de contenção no pai. Um elemento
    // já posicionado em absoluto ganha isso de graça — declarar `relative`
    // aqui sobrescreveria o `absolute` e jogaria o nó de volta no fluxo.
    const jaPosicionado = parentStrategy === 'absolute';
    if (strategy === 'absolute' && !isRoot && !jaPosicionado) decls.push(['position', 'relative']);

    // Deduplica mantendo a última declaração de cada propriedade
    const seen = new Map();
    for (const [k, v] of decls) seen.set(k, v);
    const body = [...seen.entries()].map(([k, v]) => `  ${k}: ${v};`).join('\n');
    if (body) rules.push(`.${cls} {\n${body}\n}`);

    const pad = '  '.repeat(indent);
    const comment = node.name && node.name !== cls ? ` <!-- ${esc(node.name)} -->` : '';
    // Rastreio de volta para a camada do Figma.
    const attrs = ctx.rastreio
      ? ` class="${cls}" data-fig="${esc(node.guid)}" data-fig-nome="${esc(node.name)}"`
      : ` class="${cls}"`;

    if (node.type === 'TEXT') {
      html.push(`${pad}<${tag}${attrs}>${renderTextContent(node, ctx)}</${tag}>`);
      return;
    }
    const kids = (node.children || []).filter((c) => c.visible !== false);
    if (!kids.length) {
      html.push(`${pad}<${tag}${attrs}></${tag}>${comment}`);
      return;
    }
    html.push(`${pad}<${tag}${attrs}>${comment}`);
    // Em fluxo, a ordem visual (topo -> base) é o que importa, não a ordem de camada.
    const ordered = strategy === 'flow'
      ? kids.slice().sort((a, b) => (a.position ? a.position.y : 0) - (b.position ? b.position.y : 0))
      : kids;
    ordered.forEach((c, i) => walk(c, node, depth + 1, indent + 1, strategy, ordered[i - 1]));
    html.push(`${pad}</${tag}>`);
  }

  walk(tree, null, 0, 3, null, null);

  const css = buildStylesheet(tokens, ctx, rules);
  const title = tree.name || 'Tela';
  const doc = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${fontLinks(tokens)}<link rel="stylesheet" href="./styles.css">
</head>
<body>
  <div class="canvas">
${html.join('\n')}
  </div>
</body>
</html>
`;

  return { html: doc, css, tokens, designWidth, mode };
}

/**
 * Puxa as famílias do Google Fonts.
 *
 * Sem a fonte certa o navegador usa um fallback com métricas diferentes: a
 * quebra de linha muda, a altura de cada bloco de texto muda e o erro se
 * acumula página abaixo. É a maior fonte de desvio na reconstrução.
 * Famílias que não existem no Google Fonts simplesmente não carregam e caem
 * no fallback declarado no CSS.
 */
function fontLinks(tokens) {
  const familias = [...new Set(tokens.fonts.map((f) => f.family))].filter(Boolean);
  if (!familias.length) return '';
  const pesos = new Map();
  for (const f of tokens.fonts) {
    if (!pesos.has(f.family)) pesos.set(f.family, new Set());
    pesos.get(f.family).add(f.weight || 400);
  }
  const specs = familias.map((fam) => {
    const w = [...pesos.get(fam)].sort((a, b) => a - b).join(';');
    return `family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@${w}`;
  });
  return (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    `<link href="https://fonts.googleapis.com/css2?${specs.join('&')}&display=swap" rel="stylesheet">\n`
  );
}

function buildStylesheet(tokens, ctx, rules) {
  const vars = [];
  for (const c of tokens.colors.slice(0, 24)) vars.push(`  --${c.name}: ${c.value};`);
  for (const f of tokens.families) vars.push(`  --font-${slugify(f)}: "${f}";`);
  for (const s of tokens.shadows.slice(0, 8)) vars.push(`  --${s.name}: ${s.value};`);
  vars.push(`  --design-width: ${ctx.designWidth}px;`);

  const scaleComment = ctx.scaleFactor !== 1
    ? `/* Medidas divididas por ${ctx.scaleFactor} (design reconstruido em ${ctx.designWidth}px). */\n`
    : '';

  return `${scaleComment}:root {
${vars.join('\n')}
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  -webkit-font-smoothing: antialiased;
}

/*
 * Contêiner de referência do design.
 * Todas as medidas fluidas estão em cqw (1% da largura daqui), então o layout
 * inteiro escala junto, em vez de o eixo horizontal descolar do vertical.
 * O overflow-x segura faixas desenhadas de propósito mais largas que o frame.
 */
.canvas {
  container-type: inline-size;
  width: 100%;
  max-width: var(--design-width);
  margin: 0 auto;
  overflow-x: hidden;
}

img { max-width: 100%; display: block; }

button { font: inherit; border: none; background: none; cursor: pointer; }

${rules.join('\n\n')}
`;
}

module.exports = { generateScreen, collectTokens, slugify, makeFluid };
