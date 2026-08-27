'use strict';
/**
 * Analisador do JSON decodificado pelo decode_kiwi.cjs.
 *
 * Diferenças em relação ao extract_layout.cjs do skill (que continua disponível
 * como saída "bruta"):
 *   - mantém precisão sub-pixel (o script original faz Math.round em size/position,
 *     o que estraga a conta quando dividimos pelo fator de escala);
 *   - corrige o hash de imagem: o .fig traz {0:byte,...} como objeto, e o
 *     hashToHex original exige Array.isArray -> descartava todos os fills IMAGE;
 *   - resolve texto com formatação mista (styleOverrideTable + characterStyleIDs)
 *     agrupando caracteres consecutivos de mesmo id;
 *   - detecta o fator de escala do frame raiz.
 */

const COMMON_WIDTHS = [1440, 1512, 1920, 1280, 1200, 1024, 834, 768, 430, 414, 393, 390, 375, 360];

// ---------------------------------------------------------------- utilidades

function guidOf(g) {
  return g ? `${g.sessionID}:${g.localID}` : null;
}

function hashToHex(hash) {
  if (!hash) return null;
  let hex = '';
  for (let i = 0; i < 20; i++) {
    const byte = hash[i];
    if (byte === undefined) break;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex || null;
}

function colorToHex(c) {
  if (!c) return null;
  const to = (v) => Math.round(Math.max(0, Math.min(1, v || 0)) * 255).toString(16).padStart(2, '0');
  return '#' + to(c.r) + to(c.g) + to(c.b);
}

function colorToCss(c, extraOpacity) {
  if (!c) return null;
  const a = (c.a === undefined ? 1 : c.a) * (extraOpacity === undefined ? 1 : extraOpacity);
  const hex = colorToHex(c);
  if (a >= 0.999) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
}

/** Ângulo e stops de um gradiente, a partir da matriz de transformação. */
function gradientToCss(paint) {
  const stops = (paint.gradientStops || []).map((s) => ({
    color: colorToCss(s.color),
    position: s.position,
  }));
  if (!stops.length) return null;
  const list = stops.map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`).join(', ');
  const t = paint.transform || paint.gradientTransform;
  if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
    return { css: `radial-gradient(circle, ${list})`, stops, kind: paint.type };
  }
  if (paint.type === 'GRADIENT_ANGULAR') {
    return { css: `conic-gradient(${list})`, stops, kind: paint.type };
  }
  // Linear: a matriz mapeia o eixo do gradiente; o vetor (m00, m10) dá a direção.
  let deg = 180;
  if (t && (t.m00 !== undefined || t.m10 !== undefined)) {
    const rad = Math.atan2(t.m10 || 0, t.m00 || 0);
    deg = Math.round(((rad * 180) / Math.PI + 90 + 360) % 360);
  }
  return { css: `linear-gradient(${deg}deg, ${list})`, stops, kind: 'GRADIENT_LINEAR', angle: deg };
}

function paintToObject(p) {
  if (!p) return null;
  if (p.visible === false) return null;
  const out = { type: p.type, opacity: p.opacity === undefined ? 1 : p.opacity };
  if (p.type === 'SOLID') {
    out.color = colorToCss(p.color, out.opacity);
    out.hex = colorToHex(p.color);
    out.alpha = (p.color && p.color.a !== undefined ? p.color.a : 1) * out.opacity;
  } else if (p.type === 'IMAGE') {
    out.imageHash = hashToHex(p.image && p.image.hash);
    out.imageName = p.image && p.image.name;
    out.scaleMode = p.imageScaleMode;
    out.originalWidth = p.originalImageWidth;
    out.originalHeight = p.originalImageHeight;
  } else if (String(p.type).startsWith('GRADIENT')) {
    const g = gradientToCss(p);
    if (g) Object.assign(out, g);
  }
  return out;
}

function effectToObject(e) {
  if (!e || e.visible === false) return null;
  const out = { type: e.type, radius: e.radius || 0 };
  if (e.color) out.color = colorToCss(e.color);
  if (e.offset) out.offset = { x: e.offset.x || 0, y: e.offset.y || 0 };
  if (e.spread !== undefined) out.spread = e.spread;
  return out;
}

// ------------------------------------------------------- detecção de escala

/** Quão perto de um inteiro os valores ficam ao dividir por f (0..1). */
function integernessScore(values, f) {
  if (!values.length) return 0;
  let hits = 0;
  for (const v of values) {
    const d = v / f;
    if (Math.abs(d - Math.round(d)) < 0.02 && Math.abs(d) > 0.5) hits++;
  }
  return hits / values.length;
}

/**
 * Descobre se as telas foram desenhadas em outra largura e escaladas.
 * Testa a largura do frame raiz contra larguras usuais de design e valida
 * o candidato pela "inteireza" das medidas reais (tamanhos, fontes, paddings).
 */
function detectScale(screens, nodes) {
  if (!screens.length) return { factor: 1, confidence: 0, baseWidth: null, reason: 'sem telas' };

  // Largura predominante entre as telas
  const widthFreq = new Map();
  for (const s of screens) widthFreq.set(s.width, (widthFreq.get(s.width) || 0) + 1);
  const rootWidth = [...widthFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // Amostra de medidas dentro das telas
  const values = [];
  const screenIds = new Set(screens.map((s) => s.guid));
  for (const n of nodes) {
    if (!n.screenGuid || !screenIds.has(n.screenGuid)) continue;
    if (n.size) {
      if (n.size.w > 0) values.push(n.size.w);
      if (n.size.h > 0) values.push(n.size.h);
    }
    if (n.fontSize) values.push(n.fontSize);
    if (n.padding) {
      for (const k of ['top', 'right', 'bottom', 'left']) if (n.padding[k]) values.push(n.padding[k]);
    }
    if (n.gap) values.push(n.gap);
  }
  if (values.length > 6000) values.length = 6000;

  const candidates = [];
  for (const w of COMMON_WIDTHS) {
    const f = rootWidth / w;
    if (f < 0.4 || f > 4) continue;
    candidates.push({ factor: f, baseWidth: w });
  }
  if (!candidates.some((c) => Math.abs(c.factor - 1) < 1e-9)) {
    candidates.push({ factor: 1, baseWidth: rootWidth });
  }

  const scored = candidates.map((c) => ({
    ...c,
    score: integernessScore(values, c.factor),
  }));
  scored.sort((a, b) => b.score - a.score || Math.abs(a.factor - 1) - Math.abs(b.factor - 1));

  const best = scored[0];
  const identity = scored.find((c) => Math.abs(c.factor - 1) < 1e-9);

  // Só considera o design escalado se o candidato ganhar do 1:1 com folga.
  const gain = best.score - (identity ? identity.score : 0);
  const scaled = Math.abs(best.factor - 1) > 1e-9 && gain > 0.12;

  const chosen = scaled ? best : identity || best;
  return {
    factor: Number(chosen.factor.toFixed(6)),
    baseWidth: chosen.baseWidth,
    rootWidth,
    confidence: Number(chosen.score.toFixed(3)),
    scaled,
    candidates: scored.slice(0, 6).map((c) => ({
      factor: Number(c.factor.toFixed(4)),
      baseWidth: c.baseWidth,
      score: Number(c.score.toFixed(3)),
    })),
    reason: scaled
      ? `medidas ficam inteiras ao dividir por ${chosen.factor.toFixed(4)} (${rootWidth} -> ${chosen.baseWidth})`
      : `medidas já são inteiras em ${rootWidth}px; nenhum fator melhora o encaixe`,
  };
}

// ------------------------------------------------------ texto com formatação

/**
 * Agrupa caracteres consecutivos de mesmo characterStyleID em trechos.
 * Sem isso, os destaques no meio da frase (outra fonte, outra cor) se perdem.
 */
function buildTextRuns(node) {
  const chars = node.textData && node.textData.characters;
  if (!chars) return null;
  const ids = node.textData.characterStyleIDs;
  const table = node.styleOverrideTable || [];
  if (!ids || !ids.length || !table.length) return null;

  const byId = new Map();
  for (const o of table) byId.set(o.styleID, o);

  // characterStyleIDs pode ser mais curto que o texto: o resto herda o estilo base (0).
  const idAt = (i) => (i < ids.length ? ids[i] || 0 : 0);

  const runs = [];
  let start = 0;
  let current = idAt(0);
  for (let i = 1; i <= chars.length; i++) {
    const id = i < chars.length ? idAt(i) : null;
    if (id !== current || i === chars.length) {
      const override = current ? byId.get(current) : null;
      runs.push({
        start,
        end: i,
        text: chars.slice(start, i),
        styleID: current,
        style: override
          ? {
              fontSize: override.fontSize,
              fontFamily: override.fontName && override.fontName.family,
              fontStyle: override.fontName && override.fontName.style,
              color: override.fillPaints && override.fillPaints[0]
                ? colorToCss(override.fillPaints[0].color, override.fillPaints[0].opacity)
                : null,
              letterSpacing: override.letterSpacing,
              lineHeight: override.lineHeight,
              textDecoration: override.textDecoration,
            }
          : null,
      });
      start = i;
      current = id;
    }
  }
  // Um único trecho sem override não é "formatação mista".
  if (runs.length <= 1) return null;
  return runs;
}

function fontWeightFromStyle(style) {
  if (!style) return null;
  const s = String(style).toLowerCase();
  if (s.includes('thin')) return 100;
  if (s.includes('extralight') || s.includes('ultralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('regular') || s.includes('normal') || s.includes('book')) return 400;
  if (s.includes('medium')) return 500;
  if (s.includes('semibold') || s.includes('demibold')) return 600;
  if (s.includes('extrabold') || s.includes('ultrabold')) return 800;
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('bold')) return 700;
  return 400;
}

// --------------------------------------------- instâncias de componente

/**
 * Materializa o conteúdo das instâncias de componente.
 *
 * No .fig uma INSTANCE não guarda filhos: ela aponta para um SYMBOL via
 * `symbolData.symbolID` e carrega só as diferenças em `symbolOverrides`. Sem
 * resolver isso, todo componente reutilizado (card, botão, item de lista) sai
 * como uma caixa vazia.
 *
 * A ligação entre a instância e um nó lá dentro do símbolo é o `overrideKey`:
 * cada descendente do símbolo tem um, e `guidPath.guids` é a trilha desses
 * overrideKeys da raiz do componente até o nó.
 *
 * Devolve a lista de nós crus acrescida dos clones.
 */
function expandInstances(rawNodes, maxDepth) {
  const limit = maxDepth === undefined ? 8 : maxDepth;
  const key = (x) => (x ? `${x.sessionID}:${x.localID}` : null);
  const byGuid = new Map(rawNodes.map((n) => [key(n.guid), n]));

  const childrenOf = new Map();
  for (const n of rawNodes) {
    const p = n.parentIndex && n.parentIndex.guid ? key(n.parentIndex.guid) : null;
    if (!p) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const x = (a.parentIndex && a.parentIndex.position) || '';
      const y = (b.parentIndex && b.parentIndex.position) || '';
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  const clones = [];
  let nextId = 1;
  // sessionID -1 não existe em arquivo real, então clones nunca colidem
  const newGuid = () => ({ sessionID: -1, localID: nextId++ });

  // Propriedades de controle: copiá-las para o clone quebraria a árvore.
  const ESTRUTURAIS = new Set(['guid', 'parentIndex', 'guidPath', 'overrideKey']);

  function aplicar(destino, fonte) {
    if (!fonte) return;
    for (const [k, v] of Object.entries(fonte)) {
      if (ESTRUTURAIS.has(k) || v === undefined) continue;
      destino[k] = v;
    }
  }

  function expandir(instancia, profundidade, symbolsNaPilha) {
    const dados = instancia.symbolData;
    const symbolGuid = dados && dados.symbolID ? key(dados.symbolID) : null;
    if (!symbolGuid) return;
    // Componente que contém a si mesmo entraria em recursão infinita.
    if (profundidade > limit || symbolsNaPilha.has(symbolGuid)) return;
    const symbol = byGuid.get(symbolGuid);
    if (!symbol) return;

    const overrides = new Map();
    for (const o of dados.symbolOverrides || []) {
      if (o.guidPath && o.guidPath.guids) overrides.set(o.guidPath.guids.map(key).join('/'), o);
    }
    const derivados = new Map();
    for (const d of instancia.derivedSymbolData || []) {
      if (d.guidPath && d.guidPath.guids) derivados.set(d.guidPath.guids.map(key).join('/'), d);
    }

    const pilha = new Set(symbolsNaPilha).add(symbolGuid);
    const novasInstancias = [];

    (function clonar(origemGuid, paiClonado, trilha) {
      for (const filho of childrenOf.get(origemGuid) || []) {
        const ok = filho.overrideKey ? key(filho.overrideKey) : null;
        const trilhaFilho = ok ? trilha.concat(ok) : trilha;
        const caminho = trilhaFilho.join('/');

        const clone = Object.assign({}, filho);
        clone.guid = newGuid();
        clone.parentIndex = {
          guid: paiClonado,
          position: (filho.parentIndex && filho.parentIndex.position) || '',
        };
        // O override troca propriedades (cor, texto, tamanho); o derivado traz
        // a geometria já resolvida para esta instância.
        aplicar(clone, overrides.get(caminho));
        const d = derivados.get(caminho);
        if (d) {
          if (d.size) clone.size = d.size;
          if (d.transform) clone.transform = d.transform;
        }
        clone.__deInstancia = true;
        clones.push(clone);
        if (clone.type === 'INSTANCE' && clone.symbolData) {
          novasInstancias.push(clone);
        }
        clonar(key(filho.guid), clone.guid, trilhaFilho);
      }
    })(symbolGuid, instancia.guid, []);

    for (const aninhada of novasInstancias) expandir(aninhada, profundidade + 1, pilha);
  }

  for (const n of rawNodes) {
    if (n.type === 'INSTANCE' && n.symbolData) expandir(n, 0, new Set());
  }

  return rawNodes.concat(clones);
}

// --------------------------------------------------------------- nós

const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'INSTANCE', 'SYMBOL', 'COMPONENT', 'SECTION']);

function buildNode(n) {
  const node = {
    guid: guidOf(n.guid),
    parentGuid: n.parentIndex && n.parentIndex.guid ? guidOf(n.parentIndex.guid) : null,
    order: (n.parentIndex && n.parentIndex.position) || '',
    name: n.name || '',
    type: n.type || 'UNKNOWN',
    visible: n.visible !== false,
    opacity: n.opacity === undefined ? 1 : n.opacity,
  };

  if (n.size) node.size = { w: n.size.x, h: n.size.y };
  if (n.transform) {
    node.position = { x: n.transform.m02, y: n.transform.m12 };
    const rot = Math.atan2(n.transform.m10 || 0, n.transform.m00 || 1);
    if (Math.abs(rot) > 0.001) node.rotation = Number(((rot * 180) / Math.PI).toFixed(2));
  }

  const fills = (n.fillPaints || []).map(paintToObject).filter(Boolean);
  if (fills.length) node.fills = fills;
  const strokes = (n.strokePaints || []).map(paintToObject).filter(Boolean);
  if (strokes.length) {
    node.strokes = strokes;
    node.strokeWeight = n.strokeWeight || 1;
    node.strokeAlign = n.strokeAlign;
  }
  const effects = (n.effects || []).map(effectToObject).filter(Boolean);
  if (effects.length) node.effects = effects;

  // Cantos
  if (n.rectangleCornerRadiiIndependent && n.rectangleTopLeftCornerRadius !== undefined) {
    node.cornerRadii = [
      n.rectangleTopLeftCornerRadius || 0,
      n.rectangleTopRightCornerRadius || 0,
      n.rectangleBottomRightCornerRadius || 0,
      n.rectangleBottomLeftCornerRadius || 0,
    ];
  } else if (n.cornerRadius) {
    node.cornerRadius = n.cornerRadius;
  }

  // Auto-layout em grade (recurso mais novo do Figma). O modelo é o mesmo do
  // CSS Grid: uma lista ordenada de trilhas com tamanho FLEX (fr) ou FIXED,
  // e cada filho ancorado numa trilha de linha e numa de coluna.
  if (n.stackMode === 'GRID') {
    const trilhas = (lista, sizing) => {
      const ordem = ((lista && lista.entries) || [])
        .slice()
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .map((e) => guidOf(e.id));
      const tamanhos = new Map();
      for (const e of (sizing && sizing.entries) || []) {
        const t = e.trackSize && e.trackSize.maxSizing;
        if (t) tamanhos.set(guidOf(e.id), { type: t.type, value: t.value });
      }
      return ordem.map((id) => ({ id, size: tamanhos.get(id) || { type: 'AUTO' } }));
    };
    node.grid = {
      columns: trilhas(n.gridColumns, n.gridColumnsSizing),
      rows: trilhas(n.gridRows, n.gridRowsSizing),
      columnGap: n.gridColumnGap || 0,
      rowGap: n.gridRowGap || 0,
    };
  }
  if (n.gridRowAnchor || n.gridColumnAnchor) {
    node.gridAnchor = {
      row: guidOf(n.gridRowAnchor),
      column: guidOf(n.gridColumnAnchor),
      rowSpan: n.gridRowSpan || 1,
      columnSpan: n.gridColumnSpan || 1,
      verticalAlign: n.gridChildVerticalAlign,
      horizontalAlign: n.gridChildHorizontalAlign,
    };
  }

  // Auto-layout
  if (n.stackMode && n.stackMode !== 'NONE') {
    node.layout = {
      mode: n.stackMode,
      primaryAlign: n.stackPrimaryAlignItems,
      counterAlign: n.stackCounterAlignItems,
      primarySizing: n.stackPrimarySizing,
      counterSizing: n.stackCounterSizing,
      wrap: n.stackWrap,
    };
    node.gap = n.stackSpacing || 0;
    node.padding = {
      top: n.stackVerticalPadding || 0,
      right: n.stackPaddingRight === undefined ? n.stackHorizontalPadding || 0 : n.stackPaddingRight,
      bottom: n.stackPaddingBottom === undefined ? n.stackVerticalPadding || 0 : n.stackPaddingBottom,
      left: n.stackHorizontalPadding || 0,
    };
  }
  // O Figma permite tirar um filho do fluxo do auto-layout e ancorá-lo por
  // coordenada. Tratá-lo como item de flex faz ele ocupar espaço e empurrar
  // todos os irmãos — some com o layout da seção inteira.
  if (n.stackPositioning === 'ABSOLUTE') node.absoluteInStack = true;
  if (n.stackChildPrimaryGrow) node.grow = n.stackChildPrimaryGrow;
  if (n.stackChildAlignSelf && n.stackChildAlignSelf !== 'AUTO') node.alignSelf = n.stackChildAlignSelf;
  if (n.clipsContent !== undefined) node.clipsContent = n.clipsContent;

  // Texto
  if (n.type === 'TEXT') {
    node.text = (n.textData && n.textData.characters) || '';
    node.fontSize = n.fontSize;
    if (n.fontName) {
      node.fontFamily = n.fontName.family;
      node.fontStyle = n.fontName.style;
      node.fontWeight = fontWeightFromStyle(n.fontName.style);
      node.italic = /italic|oblique/i.test(n.fontName.style || '');
    }
    if (n.lineHeight) node.lineHeight = { value: n.lineHeight.value, units: n.lineHeight.units };
    if (n.letterSpacing) node.letterSpacing = { value: n.letterSpacing.value, units: n.letterSpacing.units };
    node.textAlign = n.textAlignHorizontal || 'LEFT';
    node.textVerticalAlign = n.textAlignVertical;
    if (n.textCase) node.textCase = n.textCase;
    if (n.textDecoration) node.textDecoration = n.textDecoration;
    if (n.textAutoResize) node.textAutoResize = n.textAutoResize;
    const runs = buildTextRuns(n);
    if (runs) node.textRuns = runs;
  }

  node.isContainer = CONTAINER_TYPES.has(node.type);
  return node;
}

// -------------------------------------------------------------- análise

function analyze(message, options) {
  const opts = options || {};
  const originais = message.nodeChanges || [];
  const rawNodes = opts.expandirInstancias === false ? originais : expandInstances(originais);
  const nodes = rawNodes.map(buildNode);
  const byGuid = new Map(nodes.map((n) => [n.guid, n]));

  // Filhos ordenados pelo índice fracionário do Figma
  const childrenOf = new Map();
  for (const n of nodes) {
    if (!n.parentGuid) continue;
    if (!childrenOf.has(n.parentGuid)) childrenOf.set(n.parentGuid, []);
    childrenOf.get(n.parentGuid).push(n);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  }

  // Telas = frames com área relevante cujo pai é um CANVAS (página)
  const canvasGuids = new Set(nodes.filter((n) => n.type === 'CANVAS').map((n) => n.guid));
  const pageName = new Map(nodes.filter((n) => n.type === 'CANVAS').map((n) => [n.guid, n.name]));

  const minArea = opts.minScreenArea === undefined ? 120000 : opts.minScreenArea;
  const screens = nodes
    .filter(
      (n) =>
        canvasGuids.has(n.parentGuid) &&
        n.isContainer &&
        n.size &&
        n.size.w * n.size.h >= minArea &&
        n.visible
    )
    .map((n) => ({
      guid: n.guid,
      name: n.name,
      page: pageName.get(n.parentGuid) || 'Página',
      width: Number(n.size.w.toFixed(2)),
      height: Number(n.size.h.toFixed(2)),
      x: n.position ? n.position.x : 0,
      y: n.position ? n.position.y : 0,
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y);

  // Marca a qual tela cada nó pertence (para escala e para recortar a árvore)
  const screenGuids = new Set(screens.map((s) => s.guid));
  const assign = (guid, screenGuid) => {
    const node = byGuid.get(guid);
    if (!node) return;
    node.screenGuid = screenGuid;
    for (const c of childrenOf.get(guid) || []) assign(c.guid, screenGuid);
  };
  for (const s of screens) assign(s.guid, s.guid);

  let nodeCounts = new Map();
  for (const n of nodes) {
    if (n.screenGuid) nodeCounts.set(n.screenGuid, (nodeCounts.get(n.screenGuid) || 0) + 1);
  }
  for (const s of screens) s.nodeCount = nodeCounts.get(s.guid) || 1;

  const scale = detectScale(screens, nodes);

  // Duplicatas.
  //
  // Nome e dimensões iguais não bastam: é comum haver duas versões da mesma
  // página, com o mesmo nome e tamanho e conteúdos diferentes. Marcar a
  // segunda como duplicada faria a interface desmarcá-la e o usuário exportaria
  // a versão errada. Então a assinatura inclui o conteúdo de texto.
  const assinatura = (guid) => {
    const partes = [];
    const visit = (g) => {
      const n = byGuid.get(g);
      if (!n) return;
      if (n.type === 'TEXT' && n.text) partes.push(n.text.trim());
      for (const c of childrenOf.get(g) || []) visit(c.guid);
    };
    visit(guid);
    const texto = partes.join(' ');
    // hash barato só para não guardar a página inteira em memória
    let h = 5381;
    for (let i = 0; i < texto.length; i++) h = ((h * 33) ^ texto.charCodeAt(i)) >>> 0;
    return `${h.toString(16)}:${partes.length}`;
  };

  const seen = new Map();
  for (const s of screens) {
    const key = `${s.name}|${s.width}x${s.height}|${s.nodeCount}|${assinatura(s.guid)}`;
    if (seen.has(key)) s.duplicateOf = seen.get(key);
    else seen.set(key, s.guid);
  }

  // Página de verdade x fragmento solto no canvas (ícone, grupo, card avulso).
  // Critério: largura igual à largura predominante das telas.
  for (const s of screens) {
    s.kind = Math.abs(s.width - scale.rootWidth) < 1 ? 'page' : 'fragment';
  }

  return {
    nodes,
    byGuid,
    childrenOf,
    screens,
    scale,
    stats: {
      totalNodes: nodes.length,
      nosOriginais: originais.length,
      nosDeInstancia: rawNodes.length - originais.length,
      byType: nodes.reduce((acc, n) => ((acc[n.type] = (acc[n.type] || 0) + 1), acc), {}),
      imageFills: nodes.reduce(
        (acc, n) => acc + (n.fills || []).filter((f) => f.type === 'IMAGE' && f.imageHash).length,
        0
      ),
      autoLayout: nodes.filter((n) => n.layout).length,
      mixedText: nodes.filter((n) => n.textRuns).length,
    },
  };
}

/** Recorta a subárvore de uma tela, já com posições relativas ao pai. */
function screenTree(analysis, screenGuid, maxDepth) {
  const limit = maxDepth === undefined ? Infinity : maxDepth;
  const build = (guid, depth) => {
    const n = analysis.byGuid.get(guid);
    if (!n) return null;
    const out = { ...n };
    delete out.screenGuid;
    const kids = analysis.childrenOf.get(guid) || [];
    if (depth < limit && kids.length) {
      out.children = kids.map((c) => build(c.guid, depth + 1)).filter(Boolean);
    }
    return out;
  };
  return build(screenGuid, 0);
}

module.exports = {
  analyze,
  screenTree,
  colorToCss,
  colorToHex,
  hashToHex,
  fontWeightFromStyle,
  guidOf,
};
