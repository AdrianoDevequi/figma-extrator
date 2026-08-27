# Extrator de .fig

Interface web para extrair o layout de um arquivo `.fig` do Figma **offline** — sem
abrir o Figma e sem a API deles. Você sobe o arquivo e recebe, por tela, o HTML/CSS
reconstruído, as imagens embutidas, a especificação em Markdown e a árvore de nós.

```bash
npm install
npm start
```

Abra `http://localhost:4173`, arraste o `.fig` e escolha as telas.

## Fluxo

1. **Upload** — o `.fig` fica só na sua máquina; nada é enviado para fora.
2. **Análise** — mostra dimensões, quantidade de nós, telas encontradas e o
   diagnóstico de escala.
3. **Exportação** — você escolhe as telas, o modo e o fator de escala.
4. **Download** — `.zip` com tudo.

## O que sai no .zip

```
manifest.json            visão geral: escala, telas, estatísticas
LEIA-ME.md               o mesmo, em texto
thumbnail.png            miniatura do arquivo
assets/images/           imagens embutidas, com a extensão correta
telas/<tela>/
  index.html             HTML com classes semânticas
  styles.css             tokens em custom properties + regras
  resumo.md              dimensões, paleta, tipografia e tabela de blocos
  resumo.json            o mesmo, em JSON
  arvore.json            subárvore completa daquela tela
bruto/message.json       saída crua do decodificador (opcional, ~40 MB)
```

## Os dois modos

| | Fluido | Absoluto |
| --- | --- | --- |
| Auto-layout | vira `display:flex` com `gap`/`padding` | vira coordenada |
| Uso | código de produção | conferência, cópia fiel |
| Fidelidade medida* | 19px de desvio médio na vertical | 100% dos blocos dentro de 2px na horizontal |

\* medido no arquivo de teste (11 telas, 1920px, 3.501 nós) comparando cada nó
renderizado contra a coordenada original do Figma.

Em ambos os modos as medidas são fluidas: `clamp(mínimo, Ncqw, máximo)`, onde a
unidade é `cqw` (1% da largura do contêiner raiz) e não `vw`. Com `vw`, depois que a
raiz trava no `max-width` o eixo horizontal descola do vertical e o layout entorta;
com `cqw` os dois eixos usam a mesma referência e a tela escala junto.

Cada elemento carrega `data-fig` com o guid da camada no Figma, então dá para
rastrear qualquer bloco do HTML de volta ao design.

## Escala

Se um design feito em 1440px foi escalado para 1920, todas as medidas estão
multiplicadas por 1,3333 e o CSS sai com números quebrados. A interface testa a
largura do frame raiz contra as larguras usuais de design e pontua cada candidato
pela "inteireza" das medidas reais (tamanhos, fontes, paddings, gaps) — quanto mais
medidas caem em valores inteiros ao dividir por um fator, maior a pontuação.

O resultado aparece como tabela, com o fator vencedor destacado, e você pode
trocá-lo antes de exportar. O sistema só declara "design escalado" quando o
candidato ganha do 1:1 com folga; na dúvida, ele fica em 1:1 e mostra as
alternativas em vez de decidir sozinho.

## Texto com formatação mista

Quando um texto mistura fontes ou cores no meio da frase, o nó traz
`styleOverrideTable` + `characterStyleIDs` (um id por caractere, 0 = estilo base).
O analisador agrupa caracteres consecutivos de mesmo id para achar onde cada trecho
começa e termina, e emite um `<span>` por trecho — senão os destaques se perdem.

## Limitação conhecida

Ícones vetoriais guardam o traçado em `vectorNetworkBlob`, formato binário fechado
do Figma sem decodificador público. Eles saem como caixas posicionadas e
dimensionadas, com a cor certa, mas sem o path. Para obter o SVG é preciso a API do
Figma com o arquivo na nuvem.

## Estrutura

```
server/
  index.js      HTTP: upload, exportação, preview, download
  pipeline.js   orquestra as etapas e escreve a saída
  analyze.js    árvore de nós, escala, tokens, trechos de texto
  generate.js   HTML/CSS
  unzip.js      abre o .fig (ZIP) em Node puro
vendor/figma-parser/
  scripts do skill sunyui/figma-parser (decodificação kiwi)
public/
  interface
```

## Sobre o parser

A decodificação do binário kiwi usa os scripts de
[sunyui/figma-parser](https://github.com/sunyui/figma-parser), incluídos em
`vendor/`. Duas coisas foram feitas por fora deles:

- **Abertura do ZIP**: o `extract_archive.cjs` chama o `unzip` do sistema, que não
  existe no Windows fora do Git Bash. `server/unzip.js` faz isso em Node.
- **Análise**: `server/analyze.js` relê o JSON decodificado em vez de usar o
  `extract_layout.cjs`, por dois motivos — o script original arredonda posição e
  tamanho com `Math.round` (o que estraga a conta ao dividir pelo fator de escala),
  e o `hashToHex` dele exige `Array.isArray`, mas o hash de imagem vem como objeto
  `{0:byte,...}`, então todos os preenchimentos de imagem eram descartados. No
  arquivo de teste isso significava 0 imagens em vez de 151.
