'use strict';
/**
 * Gera HTML/CSS a partir da árvore analisada.
 *
 * Dois modos:
 *   - "fluid"    (padrão): auto-layout vira flex, medidas viram clamp() entre
 *                 360px e a largura do design; classes semânticas.
 *   - "absolute": posicionamento absoluto fiel ao pixel, para conferência.
 */

const { fontWeightFromStyle } = require('./analyze');

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
 * Garante um identificador CSS válido.
 *
 * Um seletor não pode começar com dígito nem com hífen seguido de dígito:
 * uma camada chamada "02_Home" viraria `.02-home`, que o navegador descarta —
 * a regra inteira some e o elemento fica sem estilo nenhum.
 */
function safeClass(name) {
  if (!name) return 'box';
  if (/^-?\d/.test(name)) return `n${name}`;
  return name;
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
  // Num nó de texto o fill é a cor da letra, não um fundo. Aplicá-lo como
  // background pinta um retângulo sólido exatamente da cor do texto: a frase
  // some dentro do próprio bloco. Quem trata o fill de texto é textDeclarations.
  if (node.type === 'TEXT') return decls;
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
  // O Figma tem três unidades de entrelinha e elas significam coisas diferentes:
  //   PERCENT -> porcentagem do tamanho da fonte (140 = 1.4)
  //   RAW     -> multiplicador direto (1.1 = 1.1)
  //   PIXELS  -> altura absoluta da linha
  // Tratar RAW como pixels dividia 1.1 pelo tamanho da fonte e produzia uma
  // entrelinha perto de zero: as linhas do título caíam umas sobre as outras.
  if (ctx.usarLinhas && node.lineAdvance && node.textLines && node.textLines.length > 1) {
    // Cada linha é um bloco com esta altura, então N linhas somam exatamente a
    // altura do desenho.
    decls.push(['line-height', ctx.fluid(node.lineAdvance / f)]);
  } else if (node.lineHeight && node.lineHeight.value) {
    const { value, units } = node.lineHeight;
    if (units === 'PERCENT') {
      decls.push(['line-height', String(round(value / 100, 3))]);
    } else if (units === 'RAW') {
      decls.push(['line-height', String(round(value, 3))]);
    } else if (node.fontSize) {
      decls.push(['line-height', String(round(value / node.fontSize, 3))]);
    } else {
      decls.push(['line-height', `${round(value / f, 2)}px`]);
    }
  }
  if (node.letterSpacing && node.letterSpacing.value) {
    const { value, units } = node.letterSpacing;
    if (units === 'PERCENT') decls.push(['letter-spacing', `${round(value / 100, 4)}em`]);
    else if (units === 'RAW') decls.push(['letter-spacing', `${round(value, 4)}em`]);
    else decls.push(['letter-spacing', `${round(value / f, 3)}px`]);
  }
  if (node.textAlign && node.textAlign !== 'LEFT') {
    decls.push(['text-align', TEXT_ALIGN[node.textAlign] || 'left']);
  }
  if (node.textCase === 'UPPER') decls.push(['text-transform', 'uppercase']);
  else if (node.textCase === 'LOWER') decls.push(['text-transform', 'lowercase']);
  else if (node.textCase === 'TITLE') decls.push(['text-transform', 'capitalize']);
  if (node.textDecoration === 'UNDERLINE') decls.push(['text-decoration', 'underline']);
  else if (node.textDecoration === 'STRIKETHROUGH') decls.push(['text-decoration', 'line-through']);

  // No Figma, WIDTH_AND_HEIGHT quer dizer que a caixa cresce com o texto: ele
  // nunca quebra linha. Se a largura do desenho for imposta aqui, a frase
  // quebra em duas linhas e invade o bloco de baixo. É a causa mais comum de
  // texto sobreposto em títulos escritos linha a linha.
  if (node.textAutoResize === 'WIDTH_AND_HEIGHT') {
    // A caixa abraça o texto no Figma, então ela não quebra linha sozinha.
    // Mas `max-content` deixa a largura a cargo da métrica da fonte do
    // navegador, que costuma ser mais larga: "amo.da" pedia 917px de desenho e
    // ocupava 1057px, invadindo os vizinhos. A caixa fica com a largura do
    // desenho e, se a fonte for mais larga, é o texto que transborda — isso
    // não desloca nada.
    decls.push(['white-space', 'nowrap']);
    if (node.size && node.size.w) decls.push(['width', ctx.fluid(node.size.w / ctx.scaleFactor)]);
  } else if (node.size && node.size.w) {
    // Onde a frase quebra depende só da largura da caixa. Deixar essa largura
    // ser um resultado do flex faz ela ficar alguns pixels menor que a do
    // desenho, e alguns pixels bastam para jogar uma palavra para a linha
    // seguinte — foi assim que "Happy clients worldwide" virou duas linhas com
    // 134px em vez de 138px. Aqui a largura vem do desenho, como no Figma.
    decls.push(['width', ctx.fluid(node.size.w / ctx.scaleFactor)]);
    decls.push(['flex', 'none']);
  }

  const fill = (node.fills || []).find((x) => x.type === 'SOLID' && x.color);
  if (fill) {
    decls.push(['color', fill.color]);
  } else {
    // Texto com preenchimento em gradiente: recorta o gradiente na letra.
    const grad = (node.fills || []).find((x) => x.css);
    if (grad) {
      decls.push(['background-image', grad.css]);
      decls.push(['-webkit-background-clip', 'text']);
      decls.push(['background-clip', 'text']);
      decls.push(['color', 'transparent']);
    }
  }
  return decls;
}

function layoutDeclarations(node, parent, ctx, ownStrategy) {
  const decls = [];
  const f = ctx.scaleFactor;

  // Grade do Figma vira CSS Grid de verdade. Tratá-la como coluna empilharia
  // os itens um sob o outro e a altura da seção estouraria várias vezes.
  if (node.grid) {
    const trilha = (t) => {
      if (!t.size || t.size.type === 'AUTO') return 'auto';
      if (t.size.type === 'FLEX') return `${round(t.size.value || 1, 3)}fr`;
      return ctx.fluid((t.size.value || 0) / f);
    };
    decls.push(['display', 'grid']);
    if (node.grid.columns.length) {
      decls.push(['grid-template-columns', node.grid.columns.map(trilha).join(' ')]);
    }
    if (node.grid.rows.length) {
      decls.push(['grid-template-rows', node.grid.rows.map(trilha).join(' ')]);
    }
    const rg = ctx.fluid((node.grid.rowGap || 0) / f);
    const cg = ctx.fluid((node.grid.columnGap || 0) / f);
    if (node.grid.rowGap || node.grid.columnGap) decls.push(['gap', `${rg} ${cg}`]);
  } else if (node.layout) {
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

  // Filho de grade: ancorado por id de trilha, não por ordem.
  const ALINHA_GRADE = { MIN: 'start', CENTER: 'center', MAX: 'end', STRETCH: 'stretch' };
  if (parent && parent.grid && node.gridAnchor) {
    const indice = (trilhas, id) => {
      const i = trilhas.findIndex((t) => t.id === id);
      return i < 0 ? null : i + 1;
    };
    const col = indice(parent.grid.columns, node.gridAnchor.column);
    const row = indice(parent.grid.rows, node.gridAnchor.row);
    if (col) decls.push(['grid-column', node.gridAnchor.columnSpan > 1 ? `${col} / span ${node.gridAnchor.columnSpan}` : String(col)]);
    if (row) decls.push(['grid-row', node.gridAnchor.rowSpan > 1 ? `${row} / span ${node.gridAnchor.rowSpan}` : String(row)]);
    const va = ALINHA_GRADE[node.gridAnchor.verticalAlign];
    const ha = ALINHA_GRADE[node.gridAnchor.horizontalAlign];
    if (va) decls.push(['align-self', va]);
    if (ha) decls.push(['justify-self', ha]);
  }

  // Dimensões
  const size = node.size;
  if (!size) return decls;
  const parentLayout = parent && parent.layout;
  const isHorizontal = parentLayout && parentLayout.mode === 'HORIZONTAL';

  const hugsWidth = node.layout && (isHorizontal ? node.layout.primarySizing : node.layout.counterSizing) === 'RESIZE_TO_FIT';
  const fillsWidth = node.grow === 1 && isHorizontal;

  const emGrade = parent && parent.grid && node.gridAnchor;
  if (emGrade) {
    // Quem define a largura é a trilha da grade; fixar a do desenho brigaria
    // com o `fr` e reintroduziria o estouro.
    decls.push(['min-width', '0']);
  } else if (fillsWidth) {
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

  // No Figma o padrão de um frame é altura travada; "abraçar o conteúdo" é o
  // caso explícito (RESIZE_TO_FIT, às vezes com sufixo). O campo vem ausente
  // quando é o padrão, então testar só pelo valor literal fazia a maioria dos
  // frames virar min-height e crescer — o erro somava container a container.
  // A altura mora no eixo primário quando a pilha é vertical e no secundário
  // quando é horizontal.
  const abraca = (v) => String(v || '').startsWith('RESIZE_TO_FIT');
  const alturaAbracaConteudo = node.layout
    ? node.layout.mode === 'HORIZONTAL'
      ? abraca(node.layout.counterSizing)
      : abraca(node.layout.primarySizing)
    : false;
  const conteudoDefineAltura = node.type === 'TEXT' || alturaAbracaConteudo;

  // Contêiner de auto-layout fica com `min-height`, não com altura travada.
  //
  // Travar a altura deixa o desvio de altura das telas quase zerado, e foi
  // tentador: 40 de 41 telas dentro de 5%. Mas quando o navegador quebra uma
  // frase numa linha a mais, o texto não tem para onde ir e cai por cima do
  // bloco vizinho. Medido: 18 das 21 sobreposições resultantes cobriam mais de
  // metade do texto menor — o defeito é bem pior do que a seção ficar mais
  // alta que o desenho. Deixar crescer é o mal menor.
  if (size.h) {
    if (dirigidoPeloDesenho && (node.children || []).length) {
      decls.push(['height', ctx.fluid(size.h / f)]);
    } else if (!conteudoDefineAltura) {
      decls.push(['min-height', ctx.fluid(size.h / f)]);
    } else if (node.type !== 'TEXT' && node.layout) {
      // Contêiner que abraça o conteúdo pode acabar mais CURTO que o desenho
      // se algum filho render um pouco menor, e aí o que vem depois sobe. O
      // piso impede encolher; crescer continua permitido.
      decls.push(['min-height', ctx.fluid(size.h / f)]);
      // No Figma essa caixa não tem folga, então o alinhamento do eixo
      // principal não muda nada. Com o piso ela passa a ter folga, e um
      // `center` ou `space-between` empurraria os filhos para longe do lugar.
      if (node.layout.mode !== 'HORIZONTAL') decls.push(['justify-content', 'flex-start']);
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

/** Estilo inline de um trecho de formatação mista. */
function estiloDoTrecho(style, ctx) {
  const parts = [];
  if (style.fontSize) parts.push(`font-size:${ctx.fluid(style.fontSize / ctx.scaleFactor, { minPx: 12 })}`);
  if (style.fontFamily) parts.push(`font-family:"${style.fontFamily}", sans-serif`);
  if (style.fontStyle) {
    const w = fontWeightFromStyle(style.fontStyle);
    if (w && w !== 400) parts.push(`font-weight:${w}`);
    if (/italic/i.test(style.fontStyle)) parts.push('font-style:italic');
  }
  if (style.color) parts.push(`color:${style.color}`);
  if (style.textDecoration === 'UNDERLINE') parts.push('text-decoration:underline');
  return parts.join(';');
}

/** Aplica os trechos de formatação mista a um pedaço [de, ate) do texto. */
function trechosDoIntervalo(node, de, ate, ctx) {
  const bruto = node.text.slice(de, ate);
  if (!node.textRuns) return esc(bruto);
  let out = '';
  for (const run of node.textRuns) {
    const a = Math.max(run.start, de);
    const b = Math.min(run.end, ate);
    if (a >= b) continue;
    const pedaco = esc(node.text.slice(a, b));
    if (!run.style) {
      out += pedaco;
      continue;
    }
    const css = estiloDoTrecho(run.style, ctx);
    out += css ? `<span class="run" style="${css}">${pedaco}</span>` : pedaco;
  }
  return out || esc(bruto);
}

/**
 * Conteúdo de um nó de texto.
 *
 * Quando o Figma informa onde cada linha quebra, cada linha vira um elemento
 * próprio com `white-space: pre` — o navegador não reflui e a altura do bloco
 * fica igual à do desenho. É o que impede uma palavra de descer de linha e
 * empurrar a página inteira.
 */
function renderTextContent(node, ctx) {
  if (ctx.usarLinhas && node.textLines && node.textLines.length) {
    return node.textLines
      .map((l) => {
        // O Figma inclui na linha o espaço (ou a quebra) que a encerrou; manter
        // esse rastro desalinharia texto centralizado.
        let ate = l.end;
        while (ate > l.start && /[\s\n]/.test(node.text[ate - 1])) ate--;
        const conteudo = trechosDoIntervalo(node, l.start, ate, ctx);
        return `<span class="ln">${conteudo || '&#8203;'}</span>`;
      })
      .join('');
  }
  if (!node.textRuns) return esc(node.text).replace(/\n/g, '<br>');
  return trechosDoIntervalo(node, 0, node.text.length, ctx).replace(/\n/g, '<br>');
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
    usarLinhas: opts.usarLinhas !== false,
    preferirFluxo: opts.preferirFluxo === true,
  };

  const rules = [];
  const usedClasses = new Map();
  const html = [];

  function classNameFor(node, role) {
    let base = safeClass(semanticClass(node, role) || role);
    const count = usedClasses.get(base) || 0;
    usedClasses.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  }

  /**
   * O nó vai receber `position` diferente de `static`?
   * Precisa bater com o que o walk realmente emite, porque é isso que decide
   * se a ordem de pintura do Figma se inverte.
   */
  function seraPosicionado(node, parentStrategy) {
    if (parentStrategy === 'absolute') return true;
    if (node.absoluteInStack) return true;
    const kids = (node.children || []).filter((c) => c.visible !== false);
    if (!kids.length) return false;
    if (kids.some((c) => c.absoluteInStack)) return true;
    return (mode === 'absolute' ? 'absolute' : childLayoutStrategy(node, ctx.preferirFluxo)) === 'absolute';
  }

  function walk(node, parent, depth, indent, parentStrategy, previousSibling, zIndex) {
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
    } else if (parentStrategy === 'absolute' || node.absoluteInStack) {
      decls.push(...absoluteDeclarations(node, parent, ctx));
    } else if (parentStrategy === 'flow') {
      decls.push(...flowDeclarations(node, parent, ctx, previousSibling));
    }

    const foraDoFluxo = node.absoluteInStack && parentStrategy !== 'absolute';
    const layoutDecls = layoutDeclarations(node, parent, ctx, strategy);
    // Propriedades que só fazem sentido para um item participando do fluxo.
    const DE_ITEM_FLEX = new Set(['flex', 'align-self', 'justify-self', 'grid-column', 'grid-row', 'margin-top', 'margin-left']);
    for (const [k, v] of layoutDecls) {
      // Em absoluto/fluxo a dimensão já saiu em % do pai; não sobrescreve.
      if ((k === 'width' || k === 'height') && (foraDoFluxo || (parentStrategy !== 'flex' && parentStrategy !== null)) && !isRoot) continue;
      if (isRoot && (k === 'width' || k === 'min-height' || k === 'height' || k === 'max-width')) continue;
      if (foraDoFluxo && DE_ITEM_FLEX.has(k)) continue;
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
    const jaPosicionado = parentStrategy === 'absolute' || foraDoFluxo;
    // Um contêiner de auto-layout também vira bloco de contenção quando algum
    // filho seu foi tirado do fluxo — senão esse filho ancora num ancestral
    // distante e vai parar longe do lugar.
    const filhosVisiveis = (node.children || []).filter((c) => c.visible !== false);
    const temFilhoForaDoFluxo = filhosVisiveis.some((c) => c.absoluteInStack);
    // Só quem tem filhos precisa virar bloco de contenção. Marcar uma folha
    // como `relative` a tornaria posicionada e ela passaria a pintar acima dos
    // irmãos seguintes, invertendo a ordem de camadas do Figma.
    const precisaContencao = (strategy === 'absolute' && filhosVisiveis.length > 0) || temFilhoForaDoFluxo;
    if (precisaContencao && !isRoot && !jaPosicionado) {
      decls.push(['position', 'relative']);
    }

    // Ordem de pintura.
    //
    // No Figma quem vem depois na lista de filhos fica por cima, sempre. Em CSS
    // um irmão posicionado pinta acima de um irmão estático mesmo vindo antes.
    // Onde há mistura, a ordem se inverte e um retângulo de fundo sobe para
    // cima do texto. O z-index explícito devolve a ordem do Figma.
    if (zIndex !== undefined) {
      decls.push(['z-index', String(zIndex)]);
      const posicionado = decls.some(([k, v]) => k === 'position' && v !== 'static');
      if (!posicionado) decls.push(['position', 'relative']);
    }

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
    // Só vale numerar as camadas quando há mistura de posicionado e estático:
    // se todos forem de um tipo só, a ordem do DOM já reproduz o Figma.
    const posicionados = ordered.map((c) => seraPosicionado(c, strategy));
    const misturado =
      ordered.length > 1 && posicionados.some(Boolean) && posicionados.some((p) => !p);
    ordered.forEach((c, i) =>
      walk(c, node, depth + 1, indent + 1, strategy, ordered[i - 1], misturado ? i + 1 : undefined)
    );
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
 * Zera as margens que o navegador dá de presente para p e headings.
 * Elas são proporcionais ao tamanho da fonte (1em), então um titulo de 39px
 * ganhava 39px de margem superior. Em flexbox a margem nao colapsa, entao
 * cada texto empurrava o bloco seguinte para baixo. No Figma nao existe
 * margem: o espacamento vem do gap e do padding do auto-layout.
 */
h1, h2, h3, h4, h5, h6, p, figure, blockquote, dl, dd {
  margin: 0;
}

ul, ol { margin: 0; padding: 0; list-style: none; }

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

/*
 * Uma linha de texto, quebrada onde o Figma quebrou.
 * O white-space pre impede o navegador de refluir: a altura do bloco fica
 * igual a do desenho e nenhuma palavra desce de linha empurrando o resto da
 * pagina. Se a fonte do navegador for mais larga, a linha transborda na
 * horizontal, o que nao desloca nada.
 */
.ln { display: block; white-space: pre; }

${rules.join('\n\n')}
`;
}

module.exports = { generateScreen, collectTokens, slugify, makeFluid };
