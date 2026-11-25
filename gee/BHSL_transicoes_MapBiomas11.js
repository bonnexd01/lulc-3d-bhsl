/*******************************************************************************
 * CORREDOR ECOLÓGICO BHSL — TRANSIÇÕES DE USO E COBERTURA (MapBiomas Coleção 11)
 * Complementa o script BHSL_LULC_MapBiomas_2014_2024 (áreas por classe e ano).
 *
 * O que este script produz (tudo exportado para o Google Drive, pasta GEE_exports):
 *   1. Matriz de transição 2014 → 2024, por classe (ha)            → BHSL_trans_2014_2024.csv
 *   2. Transições anuais t-1 → t (2015…2024), por classe (ha)        → BHSL_trans_anuais.csv
 *   3. Supressão e regeneração 2014→2024 por município (ha)          → BHSL_supressao_municipios.csv
 *   4. Supressão e regeneração 2014→2024 por compartimento           → BHSL_supressao_compartimento.csv
 *      (planalto ≥ 400 m × planície < 400 m — mesma cota usada na delimitação do corredor)
 *   5. Raster da dinâmica 2014→2024 (GeoTIFF, para o mapa no QGIS)    → BHSL_dinamica_2014_2024.tif
 *
 * Por que assim:
 *   - Área sempre por ee.Image.pixelArea() (m² reais de cada pixel), nunca por contagem de pixels.
 *   - Transição codificada como classe_origem*100 + classe_destino: um único reduceRegion agrupado
 *     devolve a matriz inteira, sem laços por par de classes.
 *   - Agregação em grupos (nativa / antrópica / água) feita depois, no CSV, para que a matriz detalhada
 *     continue disponível (ex.: savana → pastagem, floresta → soja).
 *   - Mesma coleção (11) em todos os anos: misturar coleções cria saltos artificiais entre anos.
 ******************************************************************************/

var SCALE = 30, MAXPIX = 1e13, TS = 8;
var Y0 = 2014, Y1 = 2024;

var corridor = ee.FeatureCollection('projects/ee-davidaranha/assets/corredor_ecologico');
var geom = corridor.geometry();
var mb = ee.Image('projects/mapbiomas-public/assets/brazil/lulc/collection11/mapbiomas_brazil_collection11_coverage_v3').clip(geom);
var areaHa = ee.Image.pixelArea().divide(1e4).rename('area_ha');

// ── Grupos (conferir a legenda oficial da Coleção 11, sobretudo a classe 7) ──
// 1 = vegetação nativa | 2 = uso antrópico | 3 = água
var NATIVE = [3, 4, 5, 6, 11, 12, 29, 49, 50];
var WATER  = [26, 33];
function toGroup(img) {
  var nat = ee.Image(0), wat = ee.Image(0);
  NATIVE.forEach(function (c) { nat = nat.or(img.eq(c)); });
  WATER.forEach(function (c) { wat = wat.or(img.eq(c)); });
  return ee.Image(2).where(nat, 1).where(wat, 3).updateMask(img.mask()).rename('grupo');
}
function cls(y) { return mb.select('classification_' + y); }

// ── 1 e 2. Matrizes de transição ──
function transition(y0, y1) {
  var code = cls(y0).multiply(100).add(cls(y1)).rename('code');
  var res = areaHa.addBands(code).reduceRegion({
    reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'code' }),
    geometry: geom, scale: SCALE, maxPixels: MAXPIX, tileScale: TS
  });
  return ee.FeatureCollection(ee.List(res.get('groups')).map(function (g) {
    g = ee.Dictionary(g);
    var c = ee.Number(g.get('code')).toInt();
    return ee.Feature(null, {
      from_year: y0, to_year: y1,
      from_class: c.divide(100).floor().toInt(), to_class: c.mod(100).toInt(),
      area_ha: g.get('sum')
    });
  }));
}
var trans0410 = transition(Y0, Y1);
var annual = ee.FeatureCollection(ee.List.sequence(Y0 + 1, Y1).map(function (y) {
  y = ee.Number(y).toInt();
  // ee.List.sequence entrega ee.Number; a seleção de banda precisa de string:
  var y0s = y.subtract(1).format('%d'), y1s = y.format('%d');
  var code = mb.select(ee.String('classification_').cat(y0s)).multiply(100)
               .add(mb.select(ee.String('classification_').cat(y1s))).rename('code');
  var res = areaHa.addBands(code).reduceRegion({
    reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'code' }),
    geometry: geom, scale: SCALE, maxPixels: MAXPIX, tileScale: TS
  });
  return ee.FeatureCollection(ee.List(res.get('groups')).map(function (g) {
    g = ee.Dictionary(g); var c = ee.Number(g.get('code')).toInt();
    return ee.Feature(null, { from_year: y.subtract(1), to_year: y,
      from_class: c.divide(100).floor().toInt(), to_class: c.mod(100).toInt(), area_ha: g.get('sum') });
  }));
})).flatten();

// ── 3 a 5. Supressão e regeneração 2014 → 2024 ──
var g0 = toGroup(cls(Y0)), g1 = toGroup(cls(Y1));
var supp  = g0.eq(1).and(g1.eq(2));   // nativa → antrópica
var regen = g0.eq(2).and(g1.eq(1));   // antrópica → nativa
var dyn = ee.Image(0)
  .where(g0.eq(1).and(g1.eq(1)), 1)   // nativa estável
  .where(g0.eq(2).and(g1.eq(2)), 2)   // antrópica estável
  .where(supp, 3)                      // supressão
  .where(regen, 4)                     // regeneração
  .where(g0.eq(3).or(g1.eq(3)), 5)     // água (em qualquer data)
  .updateMask(cls(Y0).mask()).rename('dinamica').toByte();
var flowHa = areaHa.updateMask(supp).unmask(0).rename('supressao_ha')
  .addBands(areaHa.updateMask(regen).unmask(0).rename('regeneracao_ha'));

// Municípios: FAO GAUL nível 2 (catálogo GEE). Se tiver a malha do IBGE como asset, troque aqui.
var mun = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.eq('ADM0_NAME', 'Brazil')).filterBounds(geom)
  .map(function (f) { return f.intersection(geom, 30); });
var byMun = flowHa.reduceRegions({ collection: mun, reducer: ee.Reducer.sum(), scale: SCALE, tileScale: TS })
  .select(['ADM2_NAME', 'supressao_ha', 'regeneracao_ha']);

// Compartimento: planície (< 400 m) × planalto (≥ 400 m), SRTM 30 m
var comp = ee.Image('USGS/SRTMGL1_003').lt(400).rename('planicie');  // 1 = planície, 0 = planalto
var byComp = flowHa.addBands(comp).reduceRegion({
  reducer: ee.Reducer.sum().repeat(2).group({ groupField: 2, groupName: 'planicie' }),
  geometry: geom, scale: SCALE, maxPixels: MAXPIX, tileScale: TS
});
var byCompFC = ee.FeatureCollection(ee.List(byComp.get('groups')).map(function (g) {
  g = ee.Dictionary(g); var s = ee.List(g.get('sum'));
  return ee.Feature(null, { planicie: g.get('planicie'), supressao_ha: s.get(0), regeneracao_ha: s.get(1) });
}));

print('Transições 2014→2024 (amostra):', trans0410.limit(10));
print('Supressão/regeneração por compartimento:', byCompFC);
Map.centerObject(geom, 9);
Map.addLayer(dyn, { min: 1, max: 5, palette: ['1f8d49', 'edde8e', 'd4271e', '7dc975', '2532e4'] }, 'Dinâmica 2014→2024');

// ── Exportações ──
var opts = { folder: 'GEE_exports', fileFormat: 'CSV' };
Export.table.toDrive({ collection: trans0410, description: 'BHSL_trans_2014_2024', folder: opts.folder, fileFormat: 'CSV',
  selectors: ['from_year', 'to_year', 'from_class', 'to_class', 'area_ha'] });
Export.table.toDrive({ collection: annual, description: 'BHSL_trans_anuais', folder: opts.folder, fileFormat: 'CSV',
  selectors: ['from_year', 'to_year', 'from_class', 'to_class', 'area_ha'] });
Export.table.toDrive({ collection: byMun, description: 'BHSL_supressao_municipios', folder: opts.folder, fileFormat: 'CSV',
  selectors: ['ADM2_NAME', 'supressao_ha', 'regeneracao_ha'] });
Export.table.toDrive({ collection: byCompFC, description: 'BHSL_supressao_compartimento', folder: opts.folder, fileFormat: 'CSV',
  selectors: ['planicie', 'supressao_ha', 'regeneracao_ha'] });
// O corredor (≈ 54°–55°20′ W) está majoritariamente no fuso 21S → EPSG:31981.
Export.image.toDrive({ image: dyn, description: 'BHSL_dinamica_2014_2024', folder: opts.folder, region: geom,
  scale: SCALE, crs: 'EPSG:31981', maxPixels: MAXPIX, fileFormat: 'GeoTIFF', formatOptions: { cloudOptimized: true } });
