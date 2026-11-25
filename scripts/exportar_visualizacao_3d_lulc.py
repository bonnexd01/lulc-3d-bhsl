"""
Exporta o uso e cobertura da terra (MapBiomas Coleção 11, 2014–2024) do Corredor Ecológico da BHSL
para o visualizador 3D com linha do tempo (Three.js). Mesmo motor dos visualizadores do ICEA (Artigo 3)
e de fragmentação/conectividade (Artigo 6).

Entradas (data/, geradas pelos scripts do Google Earth Engine em gee/):
  BHSL_MB11_2014_2024_stack.tif     classes MapBiomas, 11 bandas (2014..2024), EPSG:31981, 30 m
  BHSL_MapBiomas11_stats.csv        área por classe e ano
  BHSL_trans_anuais.csv             transições t-1 -> t por classe
  BHSL_trans_2014_2024.csv          matriz 2014 -> 2024
  BHSL_supressao_municipios.csv, BHSL_supressao_compartimento.csv
  BHSL_municipios.geojson           municípios (EPSG:4326)
  CESL_V01_limite_corredor.shp      limite do corredor (EPSG:4326)

Saída: docs/index.html (arquivo único; publicado pelo GitHub Pages)
Uso (na raiz do repositório): python scripts/exportar_visualizacao_3d_lulc.py [--dados DIR] [--limite SHP] [--saida HTML]
"""
import argparse
import base64
import json
import os
import zlib

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
import shapefile
from pyproj import Transformer

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(description="Gera o visualizador 3D do uso e cobertura com linha do tempo.")
ap.add_argument("--dados", default=os.path.join(BASE, "data"))
ap.add_argument("--limite", default=os.path.join(BASE, "data", "CESL_V01_limite_corredor.shp"))
ap.add_argument("--modelo", default=os.path.join(BASE, "web", "visualizador_lulc_3d.template.html"))
ap.add_argument("--saida", default=os.path.join(BASE, "docs", "index.html"))
ARGS = ap.parse_args()
DADOS = ARGS.dados

ANOS = list(range(2014, 2025))
PIX = 30.0
BLOCO = 10           # visão geral: 10 x 10 células (300 m)
JANELA = 192         # janelas de detalhe: 192 x 192 células (5,76 km)
NATIVA = [3, 4, 5, 6, 11, 12, 29, 49, 50]   # mesmos grupos do BHSL_transicoes_MapBiomas11.js
AGUA = [26, 33]
# rótulos e cores oficiais da Coleção 11 (mesma tabela do mapas_figuras_artigo2.py)
CLASSES = [
    (3, "Formação Florestal", "#1f8d49"), (4, "Formação Savânica", "#7dc975"),
    (11, "Campo Alagado e Área Pantanosa", "#519799"), (12, "Formação Campestre", "#d6bc74"),
    (29, "Afloramento Rochoso", "#ffaa5f"), (15, "Pastagem", "#edde8e"), (21, "Mosaico de Usos", "#ffefc3"),
    (39, "Soja", "#f5b3c8"), (41, "Outras Lavouras Temporárias", "#f54ca9"), (62, "Algodão", "#ff69b4"),
    (9, "Silvicultura", "#7a5900"), (24, "Área Urbanizada", "#d4271e"), (25, "Outras Áreas não Vegetadas", "#db4d4f"),
    (31, "Aquicultura", "#091077"), (33, "Rio, Lago e Oceano", "#2532e4"), (7, "Não identificada", "#9e9e9e"),
]
# grupos do gráfico da linha do tempo
GRUPOS = [
    ("Floresta", [3], "#1f8d49"), ("Savana", [4], "#7dc975"), ("Campo e áreas úmidas", [11, 12, 29], "#9fb98a"),
    ("Pastagem", [15], "#edde8e"), ("Mosaico de usos", [21], "#ffefc3"), ("Agricultura", [39, 41, 62], "#f5b3c8"),
    ("Silvicultura", [9], "#7a5900"), ("Urbano e outros", [24, 25, 7, 31], "#d4271e"), ("Água", [33, 26], "#2532e4"),
]


def b64z(a):
    return base64.b64encode(zlib.compress(np.ascontiguousarray(a, dtype=np.uint8).tobytes(), 9)).decode("ascii")


def georref(x0, y0, W, H, pix):
    """Centro da grade em lon/lat, rotação da grade UTM em relação ao leste verdadeiro (rad) e fator de escala,
    para o visualizador assentar a grade de 30 m (EPSG:31981) no mapa Web Mercator."""
    import math
    from pyproj import Geod, Transformer
    inv = Transformer.from_crs("EPSG:31981", "EPSG:4326", always_xy=True)
    cx, cy = x0 + W / 2 * pix, y0 - H / 2 * pix
    lon_c, lat_c = inv.transform(cx, cy)
    lon_e, lat_e = inv.transform(cx + 10_000, cy)
    az, _, dist = Geod(ellps="GRS80").inv(lon_c, lat_c, lon_e, lat_e)
    # malha de controle 17 x 17 (lon/lat dos nós da grade), para o navegador interpolar e projetar em Web Mercator
    n = 17
    ctrl = []
    for j in range(n):
        for i in range(n):
            lo, la = inv.transform(x0 + i / (n - 1) * W * pix, y0 - j / (n - 1) * H * pix)
            ctrl.append([round(lo, 7), round(la, 7)])
    return [round(lon_c, 7), round(lat_c, 7)], math.radians(90 - az), dist / 10_000, {"n": n, "ll": ctrl}


def log(*a):
    print(*a, flush=True)


def main():
    with rasterio.open(os.path.join(DADOS, "BHSL_MB11_2014_2024_stack.tif")) as r:
        stack = r.read()
        tr = r.transform
    nb, H, W = stack.shape
    assert nb == len(ANOS)
    x0, y0 = tr.c, tr.f
    inside = stack[0] > 0
    # códigos MapBiomas -> índices compactos 1..N (0 = fora)
    codigos = [c for c, _, _ in CLASSES]
    presentes = sorted(set(np.unique(stack).tolist()) - {0})
    for c in presentes:
        if c not in codigos:
            CLASSES.append((c, f"Classe {c}", "#9e9e9e")); codigos.append(c)
    lut = np.zeros(256, np.uint8)
    for i, c in enumerate(codigos):
        lut[c] = i + 1
    idx = lut[stack]                                    # (11, H, W)
    nat = np.isin(stack, NATIVA)
    agua = np.isin(stack, AGUA)
    antr = inside[None] & ~nat & ~agua
    log(f"grade {W} x {H}; classes presentes: {presentes}")

    # ---------------- visão geral (blocos) ----------------
    Hb, Wb = H // BLOCO, W // BLOCO
    def bl(a):
        return a[..., : Hb * BLOCO, : Wb * BLOCO].reshape(a.shape[:-2] + (Hb, BLOCO, Wb, BLOCO))
    nin = bl(inside).sum(axis=(-3, -1)).astype(np.float32)
    den = np.maximum(nin, 1)
    frac = lambda m: np.clip(np.rint(bl(m & inside).sum(axis=(-3, -1)) / den * 250), 0, 250).astype(np.uint8)
    geral = {"dentro": b64z(np.clip(np.rint(nin / BLOCO ** 2 * 250), 0, 250)), "anos": []}
    nat0 = nat[0]
    for k, ano in enumerate(ANOS):
        # classe dominante do bloco (moda) por contagem de cada índice
        b = bl(idx[k]).transpose(0, 2, 1, 3).reshape(Hb, Wb, BLOCO * BLOCO)
        cont = np.zeros((Hb, Wb, len(codigos) + 1), np.int16)
        for v in range(1, len(codigos) + 1):
            cont[..., v] = (b == v).sum(axis=-1)
        dom = cont.argmax(axis=-1).astype(np.uint8)
        dom[nin == 0] = 0
        sup = nat0 & antr[k]                            # nativa em 2014 e antrópica no ano
        reg = antr[0] & nat[k]                          # antrópica em 2014 e nativa no ano
        geral["anos"].append({"dom": b64z(dom), "nat": b64z(frac(nat[k])), "sup": b64z(frac(sup)), "reg": b64z(frac(reg))})
        log(f"  {ano}: blocos ok")

    # ---------------- janelas de detalhe ----------------
    cs = lambda m: np.pad(m.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    soma = lambda c, r, q: c[r + JANELA, q + JANELA] - c[r, q + JANELA] - c[r + JANELA, q] + c[r, q]
    c_in = cs(inside)
    c_sup = cs(nat0 & antr[-1])
    c_reg = cs(antr[0] & nat[-1])
    agri = np.isin(stack, [39, 41, 62])
    c_agr = cs(~agri[0] & agri[-1] & inside)
    # quadrado de 26 km da Fig. 5 do artigo (Guiratinga): x 810.000–836.220 m, y 8.173.000–8.199.220 m
    gq = (int((8_267_520 - 8_199_220) / PIX), int((810_000 - x0) / PIX), int(26_220 / PIX))
    cands = {"sup": (-1, 0, 0), "reg": (-1, 0, 0), "agr": (-1, 0, 0), "gui": (-1, 0, 0)}
    for r in range(0, H - JANELA, 32):
        for q in range(0, W - JANELA, 32):
            if soma(c_in, r, q) < 0.95 * JANELA * JANELA:
                continue
            vs, vr, va = soma(c_sup, r, q), soma(c_reg, r, q), soma(c_agr, r, q)
            if vs > cands["sup"][0]: cands["sup"] = (vs, r, q)
            if vr > cands["reg"][0]: cands["reg"] = (vr, r, q)
            if va > cands["agr"][0]: cands["agr"] = (va, r, q)
            if gq[0] <= r <= gq[0] + gq[2] - JANELA and gq[1] <= q <= gq[1] + gq[2] - JANELA and vs > cands["gui"][0]:
                cands["gui"] = (vs, r, q)
    escolha = [("gui", "Guiratinga: área da Fig. 5 do artigo"), ("sup", "Maior supressão 2014–2024"),
               ("agr", "Avanço da agricultura"), ("reg", "Maior regeneração")]
    janelas, usadas = [], []
    for chave, nome in escolha:
        v, r0, c0 = cands[chave]
        if v < 0 or any(abs(r0 - a) < JANELA and abs(c0 - b) < JANELA for a, b in usadas):
            log(f"  [aviso] janela '{nome}' sobreposta ou vazia; ignorada"); continue
        usadas.append((r0, c0))
        sl = (slice(None), slice(r0, r0 + JANELA), slice(c0, c0 + JANELA))
        janelas.append({"nome": nome, "criterio": chave, "r0": r0, "c0": c0, "n": JANELA,
                        "cls": b64z(idx[sl].reshape(-1)),
                        "sup_ha": round(float((nat0 & antr[-1])[sl[1:]].sum() * PIX * PIX / 1e4), 1),
                        "reg_ha": round(float((antr[0] & nat[-1])[sl[1:]].sum() * PIX * PIX / 1e4), 1)})
        log(f"  janela: {nome} | lin {r0} col {c0} | supressão {janelas[-1]['sup_ha']} ha")

    # ---------------- vetores (4326 -> 31981, em coordenadas de célula) ----------------
    tf = Transformer.from_crs("EPSG:4326", "EPSG:31981", always_xy=True)
    cel = lambda xs, ys: [[round((x - x0) / PIX, 1), round((y0 - y) / PIX, 1)] for x, y in zip(xs, ys)]
    limite = []
    for sh in shapefile.Reader(ARGS.limite).shapes():
        partes = list(sh.parts) + [len(sh.points)]
        for a_, b_ in zip(partes[:-1], partes[1:]):
            limite.append(cel(*tf.transform(*zip(*sh.points[a_:b_]))))
    mun = gpd.read_file(os.path.join(DADOS, "BHSL_municipios.geojson")).to_crs(31981)
    NOMES = {"Poxoreo": "Poxoréu", "Rondonopolis": "Rondonópolis", "Santo Antonio Do Leverger": "Santo Antônio do Leverger",
             "Sao Jose Do Povo": "São José do Povo", "Sao Pedro Da Cipa": "São Pedro da Cipa"}
    municipios = []
    for _, rr in mun.iterrows():
        def poligonos(g):
            if g.geom_type == "Polygon":
                yield g
            elif hasattr(g, "geoms"):          # MultiPolygon ou GeometryCollection (Rondonópolis)
                for h in g.geoms:
                    yield from poligonos(h)
        linhas = []
        for pg in poligonos(rr.geometry):
            pg = pg.simplify(60)
            for anel in [pg.exterior, *pg.interiors]:
                xs, ys = anel.xy
                linhas.append([[round((x - x0) / PIX, 1), round((y0 - y) / PIX, 1)] for x, y in zip(xs, ys)])
        p = rr.geometry.representative_point()
        municipios.append({"nome": NOMES.get(rr.ADM2_NAME, rr.ADM2_NAME), "chave": rr.ADM2_NAME,
                           "rot": [round((p.x - x0) / PIX, 1), round((y0 - p.y) / PIX, 1)], "linhas": linhas})

    # ---------------- números (lidos dos CSV) ----------------
    st = pd.read_csv(os.path.join(DADOS, "BHSL_MapBiomas11_stats.csv"))
    ta = pd.read_csv(os.path.join(DADOS, "BHSL_trans_anuais.csv"))
    t1 = pd.read_csv(os.path.join(DADOS, "BHSL_trans_2014_2024.csv"))
    sm = pd.read_csv(os.path.join(DADOS, "BHSL_supressao_municipios.csv"))
    sc = pd.read_csv(os.path.join(DADOS, "BHSL_supressao_compartimento.csv"))
    gr = lambda c: "n" if c in NATIVA else ("a" if c in AGUA else "t")
    serie = {g[0]: [round(float(st[(st.year == y) & st.class_code.isin(g[1])].area_ha.sum()), 1) for y in ANOS] for g in GRUPOS}
    nat_ano = [round(float(st[(st.year == y) & st.class_code.isin(NATIVA)].area_ha.sum()), 1) for y in ANOS]
    ta["gf"], ta["gt"] = ta.from_class.map(gr), ta.to_class.map(gr)
    sup_ano = [round(float(ta[(ta.to_year == y) & (ta["gf"] == "n") & (ta["gt"] == "t")].area_ha.sum()), 1) for y in ANOS[1:]]
    reg_ano = [round(float(ta[(ta.to_year == y) & (ta["gf"] == "t") & (ta["gt"] == "n")].area_ha.sum()), 1) for y in ANOS[1:]]
    t1["gf"], t1["gt"] = t1.from_class.map(gr), t1.to_class.map(gr)
    perdas = t1[(t1["gf"] == "n") & (t1["gt"] == "t")].groupby("to_class").area_ha.sum().sort_values(ascending=False)
    destino = [[int(c), round(float(v), 1), round(float(100 * v / perdas.sum()), 1)] for c, v in perdas.head(5).items()]
    numeros = {
        "nativa_ano": nat_ano, "serie": serie,
        "sup_ano": sup_ano, "reg_ano": reg_ano,
        "sup_total": round(float(sc.supressao_ha.sum()), 1), "reg_total": round(float(sc.regeneracao_ha.sum()), 1),
        "destino": destino,
        "municipios": [[NOMES.get(r.ADM2_NAME, r.ADM2_NAME), round(float(r.supressao_ha), 1), round(float(r.regeneracao_ha), 1)]
                       for r in sm.sort_values("supressao_ha", ascending=False).itertuples()],
        "compartimento": {("Planície" if int(r.planicie) == 1 else "Planalto"): [round(float(r.supressao_ha), 1), round(float(r.regeneracao_ha), 1)]
                          for r in sc.itertuples()},
    }
    log(f"nativa {nat_ano[0]} -> {nat_ano[-1]} ha; supressão 2014→2024 {numeros['sup_total']} ha")

    cll, th, kk, ctrl = georref(x0, y0, W, H, PIX)
    log(f"centro {cll}, rotação da grade {th * 180 / 3.141592653589793:.3f}°, escala {kk:.5f}")
    dados = {
        "meta": {"W": W, "H": H, "pix": PIX, "bloco": BLOCO, "Wb": Wb, "Hb": Hb, "anos": ANOS, "x0": x0, "y0": y0, "crs": "EPSG:31981",
                 "centro_ll": cll, "theta": th, "k": kk, "ctrl": ctrl},
        "classes": [[c, n, h, c in NATIVA] for c, n, h in CLASSES], "grupos": [[g[0], g[2]] for g in GRUPOS],
        "geral": geral, "janelas": janelas, "limite": limite, "municipios": municipios, "numeros": numeros,
    }
    js = json.dumps(dados, ensure_ascii=False, separators=(",", ":"))
    html = open(ARGS.modelo, encoding="utf-8").read().replace("/*__DADOS__*/null", js)
    os.makedirs(os.path.dirname(ARGS.saida), exist_ok=True)
    open(ARGS.saida, "w", encoding="utf-8", newline="\n").write(html)
    log(f"visão geral {Wb}x{Hb} | {ARGS.saida} ({os.path.getsize(ARGS.saida) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
