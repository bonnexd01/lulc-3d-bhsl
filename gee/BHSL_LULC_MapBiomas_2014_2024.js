/*******************************************************************************
 * ANÁLISE LULC — CORREDOR ECOLÓGICO BHSL
 * MapBiomas Coleção 11 | 2014–2024
 *
 * Correções aplicadas:
 *  - Paleta discreta via sldStyle (mapeamento correto código → cor)
 *  - Sintaxe "Corpo d'água" corrigida (aspas duplas)
 *  - Rótulos duplicados removidos (classes 8 e 12)
 *  - year.format('%d') para evitar ponto decimal no nome da banda
 *  - tileScale em todos os reduceRegion (previne erros de memória)
 *  - totalHa calculado uma única vez fora da função mapeada
 *  - Export.table e Export.image adicionados
 *  - Gráfico de linha para classes estratégicas
 *  - Layers visíveis apenas para o ano mais recente (desempenho)
 ******************************************************************************/

/* ══════════════════════════════════════════════════════════════
   1. CONFIGURAÇÕES GLOBAIS
   ══════════════════════════════════════════════════════════════ */
var START_YEAR = 2014;
var END_YEAR   = 2024;
var SCALE      = 30;     // resolução nativa MapBiomas (Landsat)
var MAX_PIX    = 1e13;
var TILE_SCALE = 4;      // aumente para 8 ou 16 se houver erro de memória

var years = ee.List.sequence(START_YEAR, END_YEAR);

/* ══════════════════════════════════════════════════════════════
   2. ÁREA DE ESTUDO
   ══════════════════════════════════════════════════════════════ */
var corridor = ee.FeatureCollection('projects/ee-davidaranha/assets/corredor_ecologico');
var corridorGeom = corridor.geometry();  // geometria extraída uma vez

Map.centerObject(corridor, 12);

/* ══════════════════════════════════════════════════════════════
   3. CARREGAR MapBiomas COLEÇÃO 11
   Coleção oficial com bandas anuais, incluindo classification_2024.
   ══════════════════════════════════════════════════════════════ */
var MB_PATH =
  'projects/mapbiomas-public/assets/brazil/lulc/collection11/mapbiomas_brazil_collection11_coverage_v3';

var mbImg = ee.Image(MB_PATH).clip(corridorGeom);

// Diagnóstico: conferir no Console se a banda de 2024 está disponível.
print('Bandas anuais disponíveis no MapBiomas:', mbImg.bandNames());
print('Banda de classificação 2024:', mbImg.select('classification_2024'));

/* ══════════════════════════════════════════════════════════════
   4. DICIONÁRIO CÓDIGO → RÓTULO (MapBiomas Coleção 11)
   Rótulos das classes utilizadas na série histórica.
   ══════════════════════════════════════════════════════════════ */
var LULC_LABELS = ee.Dictionary({
  '1':  'Floresta',
  '3':  'Formação Florestal',
  '4':  'Formação Savânica',
  '5':  'Mangue',
  '6':  'Floresta Alagável',
  '9':  'Silvicultura',
  '10': 'Veg. Herbácea/Arbustiva',
  '11': 'Campo Alagado/Pantanoso',
  '12': 'Formação Campestre',
  '14': 'Agropecuária',
  '15': 'Pastagem',
  '18': 'Agricultura',
  '19': 'Lavoura Temporária',
  '20': 'Cana-de-açúcar',
  '21': 'Mosaico de Usos',
  '22': 'Área Não Vegetada',
  '23': 'Praia/Duna/Areal',
  '24': 'Área Urbanizada',
  '25': 'Outras Áreas Não Vegetadas',
  '26': "Corpo d'água",            // aspas duplas — evita SyntaxError
  '27': 'Não Observado',
  '29': 'Afloramento Rochoso',
  '30': 'Mineração',
  '31': 'Aquicultura',
  '32': 'Apicum',
  '33': 'Rio/Lago/Oceano',
  '35': 'Dendê',
  '36': 'Lavoura Perene',
  '39': 'Soja',
  '40': 'Arroz',
  '41': 'Outras Lavouras Temporárias',
  '46': 'Café',
  '47': 'Citrus',
  '48': 'Outras Lavouras Perenes',
  '49': 'Restinga Arbórea',
  '50': 'Restinga Herbácea',
  '62': 'Algodão',
  '75': 'Usina de energia fotovoltaica'
});

/* ══════════════════════════════════════════════════════════════
   5. VISUALIZAÇÃO DISCRETA — SLD STYLE
   Substitui a paleta sequencial (min/max) que atribuía cores
   incorretas às classes não-sequenciais do MapBiomas.
   Cores baseadas na legenda MapBiomas; confira a legenda oficial da Coleção 11
   ══════════════════════════════════════════════════════════════ */
var sldStyle = [
  '<RasterSymbolizer>',
  '  <ColorMap type="values" extended="false">',
  '    <ColorMapEntry color="#1f8d49" quantity="1"  label="Floresta"/>',
  '    <ColorMapEntry color="#1f8d49" quantity="3"  label="Formação Florestal"/>',
  '    <ColorMapEntry color="#7dc975" quantity="4"  label="Formação Savânica"/>',
  '    <ColorMapEntry color="#04381d" quantity="5"  label="Mangue"/>',
  '    <ColorMapEntry color="#026975" quantity="6"  label="Floresta Alagável"/>',
  '    <ColorMapEntry color="#7a5900" quantity="9"  label="Silvicultura"/>',
  '    <ColorMapEntry color="#d6bc74" quantity="10" label="Veg. Herbácea/Arbustiva"/>',
  '    <ColorMapEntry color="#519799" quantity="11" label="Campo Alagado/Pantanoso"/>',
  '    <ColorMapEntry color="#d6bc74" quantity="12" label="Formação Campestre"/>',
  '    <ColorMapEntry color="#ffefc3" quantity="14" label="Agropecuária"/>',
  '    <ColorMapEntry color="#edde8e" quantity="15" label="Pastagem"/>',
  '    <ColorMapEntry color="#e974ed" quantity="18" label="Agricultura"/>',
  '    <ColorMapEntry color="#c27ba0" quantity="19" label="Lavoura Temporária"/>',
  '    <ColorMapEntry color="#db7093" quantity="20" label="Cana-de-açúcar"/>',
  '    <ColorMapEntry color="#ffefc3" quantity="21" label="Mosaico de Usos"/>',
  '    <ColorMapEntry color="#d4271e" quantity="22" label="Área Não Vegetada"/>',
  '    <ColorMapEntry color="#ffa07a" quantity="23" label="Praia/Duna/Areal"/>',
  '    <ColorMapEntry color="#d4271e" quantity="24" label="Área Urbanizada"/>',
  '    <ColorMapEntry color="#db4d4f" quantity="25" label="Outras Áreas Não Vegetadas"/>',
  '    <ColorMapEntry color="#0000ff" quantity="26" label="Corpo dagua"/>',
  '    <ColorMapEntry color="#ffffff" quantity="27" label="Não Observado"/>',
  '    <ColorMapEntry color="#ff8c00" quantity="29" label="Afloramento Rochoso"/>',
  '    <ColorMapEntry color="#9c0027" quantity="30" label="Mineração"/>',
  '    <ColorMapEntry color="#091077" quantity="31" label="Aquicultura"/>',
  '    <ColorMapEntry color="#fc8114" quantity="32" label="Apicum"/>',
  '    <ColorMapEntry color="#2532e4" quantity="33" label="Rio/Lago/Oceano"/>',
  '    <ColorMapEntry color="#9065d0" quantity="35" label="Dendê"/>',
  '    <ColorMapEntry color="#c59ff4" quantity="36" label="Lavoura Perene"/>',
  '    <ColorMapEntry color="#f5b3c8" quantity="39" label="Soja"/>',
  '    <ColorMapEntry color="#c71585" quantity="40" label="Arroz"/>',
  '    <ColorMapEntry color="#f54ca9" quantity="41" label="Outras Lavouras Temporárias"/>',
  '    <ColorMapEntry color="#d082de" quantity="46" label="Café"/>',
  '    <ColorMapEntry color="#ccff66" quantity="47" label="Citrus"/>',
  '    <ColorMapEntry color="#a4c0e5" quantity="48" label="Outras Lavouras Perenes"/>',
  '    <ColorMapEntry color="#02d659" quantity="49" label="Restinga Arbórea"/>',
  '    <ColorMapEntry color="#ad5100" quantity="50" label="Restinga Herbácea"/>',
  '    <ColorMapEntry color="#ff69b4" quantity="62" label="Algodão"/>',
  '    <ColorMapEntry color="#c12100" quantity="75" label="Usina de energia fotovoltaica"/>',
  '  </ColorMap>',
  '</RasterSymbolizer>'
].join('\n');

/* ══════════════════════════════════════════════════════════════
   6. ADICIONAR CAMADAS AO MAPA
   Apenas o ano mais recente visível por padrão (desempenho).
   Os demais ficam disponíveis no painel de layers.
   ══════════════════════════════════════════════════════════════ */
// Anos históricos — ocultos por padrão
years.getInfo().forEach(function(y) {
  var band = mbImg.select('classification_' + y);
  Map.addLayer(band.sldStyle(sldStyle), {}, 'LULC ' + y, false);
});

// Ano mais recente — visível por padrão
Map.addLayer(
  mbImg.select('classification_' + END_YEAR).sldStyle(sldStyle),
  {},
  'LULC ' + END_YEAR + ' (ativo)',
  true
);

// Delimitação do corredor (sobreposta acima dos rasters)
Map.addLayer(
  corridor.style({ color: '#00ff00', fillColor: '00000000', width: 2 }),
  {},
  'Corredor Ecológico BHSL'
);

/* ══════════════════════════════════════════════════════════════
   7. ÁREA TOTAL DO CORREDOR (calculada uma única vez)
   Evita recalcular 10x dentro da função mapeada por ano.
   ══════════════════════════════════════════════════════════════ */
var areaHa = ee.Image.pixelArea().divide(1e4);  // m² → ha

var totalHa = areaHa.reduceRegion({
  reducer:   ee.Reducer.sum(),
  geometry:  corridorGeom,
  scale:     SCALE,
  maxPixels: MAX_PIX,
  tileScale: TILE_SCALE
}).getNumber('area');

/* ══════════════════════════════════════════════════════════════
   8. FUNÇÃO: ÁREA (ha) E PERCENTUAL POR CLASSE PARA UM ANO
   ══════════════════════════════════════════════════════════════ */
function computeYearStats(year) {
  year = ee.Number(year).toInt();

  // format('%d') garante inteiro sem casas decimais (ex: "2014", não "2014.0")
  var bandName = ee.String('classification_').cat(year.format('%d'));
  var classImg = mbImg.select(bandName);

  // Reducer agrupado: soma de área por classe (groupField=1 → segunda banda)
  var grouped = areaHa
    .addBands(classImg.rename('class'))
    .reduceRegion({
      reducer: ee.Reducer.sum().group({
        groupField: 1,
        groupName:  'class'
      }),
      geometry:  corridorGeom,
      scale:     SCALE,
      maxPixels: MAX_PIX,
      tileScale: TILE_SCALE      // previne "User memory limit exceeded"
    });

  // Montar uma Feature por classe
  return ee.List(grouped.get('groups')).map(function(item) {
    item = ee.Dictionary(item);
    var code = ee.Number(item.get('class')).toInt();
    var ha   = ee.Number(item.get('sum'));
    var pct  = ha.divide(totalHa).multiply(10000).round().divide(100); // 2 casas

    return ee.Feature(null, {
      year:        year,
      class_code:  code,
      class_label: LULC_LABELS.get(code.format('%d'), 'Desconhecido'),
      area_ha:     ha.multiply(100).round().divide(100),               // 2 casas
      percent:     pct
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   9. CALCULAR ESTATÍSTICAS 2014–2024
   ══════════════════════════════════════════════════════════════ */
var statsFC = ee.FeatureCollection(
  years.map(computeYearStats).flatten()
);

print('Estatísticas LULC por classe e ano (2014–2024):', statsFC);

/* ══════════════════════════════════════════════════════════════
   10. GRÁFICO 1 — BARRAS EMPILHADAS: % de área por classe e ano
   ══════════════════════════════════════════════════════════════ */
var chartStacked = ui.Chart.feature.groups({
  features:       statsFC,
  xProperty:      'year',
  yProperty:      'percent',
  seriesProperty: 'class_label'
})
.setChartType('ColumnChart')
.setOptions({
  title:    'Evolução LULC — Corredor Ecológico BHSL (2014–2024)',
  subtitle: 'MapBiomas Coleção 11 | Escala 30 m',
  hAxis: {
    title:     'Ano',
    format:    '####',
    gridlines: { count: 10 }
  },
  vAxis: {
    title:    'Área (%)',
    minValue: 0,
    maxValue: 100
  },
  isStacked:  true,
  legend:     { position: 'right', textStyle: { fontSize: 9 } },
  fontSize:   11,
  chartArea:  { width: '65%' }
});

print(chartStacked);

/* ══════════════════════════════════════════════════════════════
   11. GRÁFICO 2 — LINHAS: tendência das classes estratégicas
   Ajuste os códigos em KEY_CLASSES conforme interesse do estudo.
   ══════════════════════════════════════════════════════════════ */
var KEY_CLASSES = [3, 4, 12, 15, 19, 24];
// 3=Form. Florestal | 4=Form. Savânica | 12=Form. Campestre
// 15=Pastagem | 19=Lavoura Temporária | 24=Área Urbanizada

var filteredFC = statsFC.filter(
  ee.Filter.inList('class_code', KEY_CLASSES)
);

var chartLine = ui.Chart.feature.groups({
  features:       filteredFC,
  xProperty:      'year',
  yProperty:      'percent',
  seriesProperty: 'class_label'
})
.setChartType('LineChart')
.setOptions({
  title:    'Tendência das Classes Principais — BHSL (2014–2024)',
  subtitle: 'Formações naturais vs. usos antrópicos',
  hAxis: { title: 'Ano', format: '####' },
  vAxis: { title: 'Área (%)' },
  lineWidth: 2,
  pointSize: 5,
  curveType: 'function',
  legend:    { position: 'right', textStyle: { fontSize: 9 } },
  fontSize:  11,
  chartArea: { width: '65%' }
});

print(chartLine);

/* ══════════════════════════════════════════════════════════════
   12. EXPORTAR TABELA DE ESTATÍSTICAS → DRIVE
   Permite análise posterior em R, Python ou Excel.
   Acione via Tasks > Run após executar o script.
   ══════════════════════════════════════════════════════════════ */
Export.table.toDrive({
  collection:     statsFC,
  description:    'BHSL_LULC_stats_2014_2024',
  folder:         'GEE_exports',
  fileNamePrefix: 'BHSL_MapBiomas11_stats',
  fileFormat:     'CSV',
  selectors:      ['year', 'class_code', 'class_label', 'area_ha', 'percent']
});

/* ══════════════════════════════════════════════════════════════
   13. EXPORTAR RASTER DO ANO MAIS RECENTE → DRIVE
   CRS: SIRGAS 2000 UTM — ajuste a zona conforme localização do corredor
   (ex: 22S = EPSG:31982 | 23S = EPSG:31983 | 24S = EPSG:31984)
   ══════════════════════════════════════════════════════════════ */
Export.image.toDrive({
  image: mbImg
    .select('classification_' + END_YEAR)
    .toByte()                 // tipo inteiro adequado para classes
    .clip(corridorGeom),
  description:    'BHSL_LULC_raster_' + END_YEAR,
  folder:         'GEE_exports',
  fileNamePrefix: 'BHSL_MapBiomas11_' + END_YEAR,
  region:         corridorGeom,
  scale:          SCALE,
  crs:            'EPSG:31982',   // ← ajuste conforme sua zona UTM
  maxPixels:      MAX_PIX,
  fileFormat:     'GeoTIFF',
  formatOptions:  { cloudOptimized: true }
});

/* ══════════════════════════════════════════════════════════════
   14. THUMBNAILS PNG — PREVIEW INLINE NO CONSOLE (DOWNLOAD IMEDIATO)
   Cada thumbnail aparece no painel do Console com um botão de
   download direto — não requer execução de Task.
   Resolução máxima: 1024 px no eixo maior.
   ══════════════════════════════════════════════════════════════ */
print('═══════════════════════════════════');
print('THUMBNAILS LULC — Corredor BHSL');
print('Clique na imagem para ampliar/baixar');
print('═══════════════════════════════════');

years.getInfo().forEach(function(y) {
  var img = mbImg
    .select('classification_' + y)
    .sldStyle(sldStyle);  // RGB estilizado com cores oficiais MapBiomas

  var thumb = ui.Thumbnail({
    image: img,
    params: {
      region:     corridorGeom,
      dimensions: 1024,          // lado máximo em pixels
      format:     'png'
    },
    style: {
      height:      '220px',
      width:       '340px',
      margin:      '4px 0',
      border:      '1px solid #ccc'
    }
  });

  print('LULC ' + y, thumb);
});

/* ══════════════════════════════════════════════════════════════
   15. THUMBNAILS PNG → DRIVE (TODOS OS ANOS, ALTA RESOLUÇÃO)
   Gera 11 tarefas (uma por ano) no painel Tasks > Run All.
   Parâmetro "dimensions: 2048" define o lado maior em pixels;
   o GEE calcula o lado menor proporcionalmente.
   ══════════════════════════════════════════════════════════════ */
years.getInfo().forEach(function(y) {
  var imgRGB = mbImg
    .select('classification_' + y)
    .sldStyle(sldStyle);  // 3 bandas RGB uint8 prontas para PNG

  Export.image.toDrive({
    image:          imgRGB,
    description:    'thumb_BHSL_LULC_' + y,
    folder:         'GEE_exports/thumbnails_BHSL',
    fileNamePrefix: 'thumb_BHSL_MapBiomas11_' + y,
    region:         corridorGeom,
    dimensions:     2048,          // lado maior; proporcional ao menor
    fileFormat:     'PNG',
    maxPixels:      MAX_PIX
  });
});

// Fim do script