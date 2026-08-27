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

\* medido no primeiro arquivo de teste (11 telas, 1920px, 3.501 nós) comparando cada
nó renderizado contra a coordenada original do Figma.

Além do posicionamento, o auto-layout do Figma é traduzido inteiro: pilhas viram
flexbox, grades viram CSS Grid com as trilhas reais (`fr` e tamanhos fixos), e
filhos marcados como `stackPositioning: ABSOLUTE` saem do fluxo e são ancorados por
coordenada, como no Figma. Tratar uma grade como coluna triplicava a altura da
seção; tratar um filho fora de fluxo como item de flex empurrava todos os irmãos.

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

## Componentes

Uma `INSTANCE` não guarda filhos no `.fig`: ela aponta para um `SYMBOL` e carrega só
as diferenças em `symbolOverrides`. Sem resolver isso, todo componente reutilizado
(card, botão, item de lista) sai como caixa vazia. O elo entre a instância e um nó
lá dentro é o `overrideKey` — cada descendente do símbolo tem um, e `guidPath.guids`
é a trilha desses overrideKeys. O analisador materializa essa árvore, aplica os
overrides e a geometria já resolvida de `derivedSymbolData`.

Nos arquivos de teste isso recuperou 269 nós (84 textos) em um e 1.731 no outro.

## Limitações conhecidas

**Ícones vetoriais.** O traçado mora em `vectorNetworkBlob`, formato binário fechado
do Figma sem decodificador público. Eles saem como caixas posicionadas e
dimensionadas, com a cor certa, mas sem o path. Para obter o SVG é preciso a API do
Figma com o arquivo na nuvem.

**Texto quebra diferente do Figma.** O navegador e o Figma não concordam sobre onde
uma linha termina, e onde há auto-layout uma linha a mais empurra o que está abaixo.
Medido em dois arquivos (57 telas, 2.842 textos): 2 a 3% dos textos acabam
encostando em outro bloco.

Vale registrar a tentativa que não deu certo, porque o número engana: travar a
altura de todo contêiner de auto-layout (em vez de `min-height`) leva o desvio de
altura das telas de 29/41 para 40/41 dentro de 5%. Só que aí o texto que não cabe
não tem para onde ir e cai por cima do vizinho — 18 das 21 sobreposições
resultantes cobriam mais da metade do texto menor. A seção ficar mais alta que o
desenho é o mal menor, então o `min-height` ficou.

**Fontes fora do Google Fonts** (TT Commons, Switzer e afins) não carregam e caem no
fallback, com métricas diferentes — o que piora o item acima.

**Ordem de camadas.** No Figma quem vem depois na lista de filhos fica por cima,
sempre. Em CSS um irmão posicionado pinta acima de um irmão estático mesmo vindo
antes, então onde há mistura a ordem se inverte e um retângulo de fundo sobe para
cima do texto. O gerador devolve a ordem do Figma com `z-index` explícito nesses
contêineres. Sobram poucos casos (26 textos em 41 telas no arquivo maior).
