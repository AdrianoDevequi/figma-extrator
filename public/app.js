'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const estado = {
  id: null,
  telas: [],
  escala: null,
  exportadas: [],
  telaAtiva: null,
  larguraPreview: 1440,
};

// ------------------------------------------------------------------ upload

const zona = $('#zona');
const inputArquivo = $('#input-arquivo');

['dragenter', 'dragover'].forEach((ev) =>
  zona.addEventListener(ev, (e) => {
    e.preventDefault();
    zona.classList.add('sobre');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  zona.addEventListener(ev, (e) => {
    e.preventDefault();
    zona.classList.remove('sobre');
  })
);
zona.addEventListener('drop', (e) => {
  const arquivo = e.dataTransfer.files && e.dataTransfer.files[0];
  if (arquivo) enviar(arquivo);
});
inputArquivo.addEventListener('change', () => {
  if (inputArquivo.files[0]) enviar(inputArquivo.files[0]);
});

$('#btn-reiniciar').addEventListener('click', () => {
  if (estado.id) navigator.sendBeacon && fetch(`/api/run/${estado.id}`, { method: 'DELETE' });
  location.reload();
});

async function enviar(arquivo) {
  if (!/\.fig$/i.test(arquivo.name)) {
    return mostrarErro('Esse arquivo não é um .fig. Exporte pelo Figma em Arquivo > Salvar cópia local.');
  }
  mostrarErro(null);
  zona.hidden = true;
  $('#progresso').hidden = false;
  $('#lista-etapas').innerHTML = '<li>Enviando o arquivo…</li>';

  const form = new FormData();
  form.append('arquivo', arquivo);

  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: form });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro || 'Falha no processamento.');
    estado.id = dados.id;
    estado.telas = dados.telas;
    estado.escala = dados.escala;
    $('#progresso').hidden = true;
    $('#etapa-upload').hidden = true;
    $('#btn-reiniciar').hidden = false;
    renderAnalise(dados);
  } catch (e) {
    $('#progresso').hidden = true;
    zona.hidden = false;
    mostrarErro(e.message);
  }
}

function mostrarErro(msg) {
  const el = $('#erro-upload');
  el.hidden = !msg;
  el.textContent = msg || '';
}

// ----------------------------------------------------------------- análise

function renderAnalise(d) {
  $('#etapa-analise').hidden = false;

  $('#nome-arquivo').textContent = d.meta.nome || d.arquivo;
  if (d.thumbnail) {
    const t = $('#thumb');
    t.src = d.thumbnail;
    t.hidden = false;
  }

  const paginas = d.telas.filter((t) => t.tipo === 'page' && !t.duplicada).length;
  $('#stats').innerHTML = [
    ['Tamanho', `${d.tamanhoMB} MB`],
    ['Nós', d.stats.totalNodes.toLocaleString('pt-BR')],
    ['Telas', `${d.telas.length} (${paginas} páginas)`],
    ['Auto-layout', d.stats.autoLayout.toLocaleString('pt-BR')],
    ['Imagens', d.imagens],
    ['Texto misto', d.stats.mixedText],
  ]
    .map(([k, v]) => `<li>${k} <b>${v}</b></li>`)
    .join('');

  renderEscala(d.escala);
  renderTelas(d.telas);
}

function renderEscala(escala) {
  const selo = $('#selo-escala');
  if (escala.scaled) {
    selo.textContent = 'design escalado';
    selo.className = 'selo alerta';
    $('#texto-escala').innerHTML =
      `O frame raiz mede <code>${escala.rootWidth}px</code>, mas as medidas só ficam redondas ` +
      `ao dividir por <code>${escala.factor}</code> — o design foi feito em <code>${escala.baseWidth}px</code> ` +
      `e escalado. O fator abaixo já vem aplicado.`;
  } else {
    selo.textContent = 'sem escala';
    selo.className = 'selo ok';
    $('#texto-escala').innerHTML =
      `O frame raiz mede <code>${escala.rootWidth}px</code> e as medidas já encaixam nessa largura ` +
      `(${(escala.confidence * 100).toFixed(0)}% delas caem em valores inteiros). Nenhum fator ` +
      `candidato melhorou o encaixe, então a exportação sai <strong>1:1</strong>. ` +
      `Se você sabe que o design nasceu em outra largura, troque o fator abaixo.`;
  }

  $('#corpo-escala').innerHTML = (escala.candidates || [])
    .map((c) => {
      const vencedor = Math.abs(c.factor - escala.factor) < 1e-6;
      return `<tr class="${vencedor ? 'vencedor' : ''}">
        <td class="num">${c.factor}</td>
        <td class="num">${c.baseWidth}px</td>
        <td class="num">${(c.score * 100).toFixed(1)}%</td>
        <td><button type="button" class="link" data-fator="${c.factor}">usar</button></td>
      </tr>`;
    })
    .join('');

  $('#input-escala').value = escala.factor;

  $('#corpo-escala').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fator]');
    if (b) $('#input-escala').value = b.dataset.fator;
  });
}

function renderTelas(telas) {
  $('#lista-telas').innerHTML = telas
    .map((t) => {
      const marcada = t.tipo === 'page' && !t.duplicada;
      const tags = [
        t.tipo === 'page' ? '<span class="tag">página</span>' : '<span class="tag">fragmento</span>',
        t.duplicada ? '<span class="tag dup">duplicada</span>' : '',
      ].join('');
      return `<label class="tela">
        <input type="checkbox" value="${t.guid}" ${marcada ? 'checked' : ''}>
        <span class="tela-info">
          <span class="tela-nome">${escapar(t.nome)}</span>
          <span class="tela-meta">${t.largura} x ${t.altura} · ${t.nos} nós</span>
          <span class="tela-tags">${tags}</span>
        </span>
      </label>`;
    })
    .join('');
}

$$('[data-sel]').forEach((b) =>
  b.addEventListener('click', () => {
    const modo = b.dataset.sel;
    $$('#lista-telas input').forEach((input, i) => {
      const tela = estado.telas[i];
      if (modo === 'todas') input.checked = true;
      else if (modo === 'nenhuma') input.checked = false;
      else input.checked = tela.tipo === 'page' && !tela.duplicada;
    });
  })
);

// -------------------------------------------------------------- exportação

$('#btn-exportar').addEventListener('click', async () => {
  const selecionadas = $$('#lista-telas input:checked').map((i) => i.value);
  if (!selecionadas.length) {
    $('#status-export').textContent = 'Selecione ao menos uma tela.';
    return;
  }
  const btn = $('#btn-exportar');
  btn.disabled = true;
  $('#status-export').textContent = `Gerando ${selecionadas.length} tela(s)…`;

  try {
    const resp = await fetch(`/api/run/${estado.id}/exportar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telas: selecionadas,
        escala: Number($('#input-escala').value) || 1,
        modo: document.querySelector('input[name="modo"]:checked').value,
        viewportMin: Number($('#input-viewport').value) || 360,
      }),
    });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro || 'Falha ao gerar.');
    estado.exportadas = dados.telas;
    $('#status-export').textContent = '';
    renderResultado(dados);
    $('#etapa-resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#status-export').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

function renderResultado(dados) {
  $('#etapa-resultado').hidden = false;
  const bruto = $('#chk-bruto') && $('#chk-bruto').checked ? '?bruto=1' : '';
  $('#btn-download').href = `/api/run/${estado.id}/download${bruto}`;

  const m = dados.manifest;
  $('#texto-resultado').innerHTML =
    `${m.telas.length} tela(s) em modo <strong>${m.modo === 'fluid' ? 'fluido' : 'absoluto'}</strong>, ` +
    `fator <code>${m.escala.fator}</code>, ${m.imagens} imagens. ` +
    `O .zip traz o HTML/CSS por tela, <code>resumo.md</code>, <code>arvore.json</code>, ` +
    `as imagens${bruto ? ' e o JSON bruto do parser' : ''}.`;

  $('#abas-telas').innerHTML = dados.telas
    .map(
      (t, i) => `<button type="button" class="aba ${i === 0 ? 'ativa' : ''}" data-i="${i}">
        ${escapar(t.name)}<small>${t.width} x ${t.height}</small>
      </button>`
    )
    .join('');

  $$('#abas-telas .aba').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#abas-telas .aba').forEach((x) => x.classList.remove('ativa'));
      b.classList.add('ativa');
      abrirTela(Number(b.dataset.i));
    })
  );

  abrirTela(0);
}

function abrirTela(i) {
  const t = estado.exportadas[i];
  if (!t) return;
  estado.telaAtiva = t;
  $('#preview').src = t.preview;
  $('#abrir-nova').href = t.preview;
  aplicarLargura();
  renderDetalhe(t);
}

$$('.largura').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.largura').forEach((x) => x.classList.remove('ativa'));
    b.classList.add('ativa');
    estado.larguraPreview = Number(b.dataset.w);
    aplicarLargura();
  })
);

function aplicarLargura() {
  const frame = $('#preview');
  const w = estado.larguraPreview;
  // Antes de a moldura ter largura medida (primeira pintura, painel escondido),
  // dividir por ela daria uma escala minúscula e a prévia sumiria.
  const disponivel = $('.moldura').clientWidth || w;
  const escala = Math.max(0.1, Math.min(1, disponivel / w));
  frame.style.width = w + 'px';
  frame.style.transform = `scale(${escala})`;
  frame.style.height = Math.round(4000 / escala) + 'px';
}

function renderDetalhe(t) {
  const cores = (t.tokens.colors || [])
    .map(
      (c) => `<span class="ficha-cor"><i class="amostra-cor" style="background:${c.value}"></i>${c.value} · ${c.count}</span>`
    )
    .join('');
  const fontes = (t.tokens.fonts || []).map((f) => `${escapar(f.family)} ${f.weight} <span style="color:var(--txt-fraco)">(${f.count})</span>`).join(' · ');
  const tamanhos = (t.tokens.fontSizes || []).map((f) => `${f.value}px`).join(', ');

  $('#detalhe-tela').innerHTML = `
    <div class="cartao-cabecalho"><h3>${escapar(t.name)} — ${t.width} x ${t.height}px</h3>
      <span style="color:var(--txt-fraco);font-size:.8rem">${t.blockCount} blocos mapeados</span></div>
    <h4 style="margin:0 0 8px;font-size:.82rem;color:var(--txt-fraco);text-transform:uppercase;letter-spacing:.03em">Paleta</h4>
    <div class="paleta">${cores || '<em style="color:var(--txt-fraco)">sem cores sólidas</em>'}</div>
    <h4 style="margin:0 0 6px;font-size:.82rem;color:var(--txt-fraco);text-transform:uppercase;letter-spacing:.03em">Tipografia</h4>
    <p style="margin:0 0 6px;font-size:.86rem">${fontes || '—'}</p>
    <p style="margin:0;font-size:.82rem;color:var(--txt-suave)">Tamanhos: <code>${tamanhos || '—'}</code></p>
  `;
}

function escapar(s) {
  const d = document.createElement('div');
  d.textContent = s === undefined || s === null ? '' : s;
  return d.innerHTML;
}

window.addEventListener('resize', () => {
  if (estado.telaAtiva) aplicarLargura();
});
